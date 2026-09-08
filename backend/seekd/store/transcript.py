"""Per-character transcript store — one SQLite ``seek.db`` per member.

Each *character* in a session owns a SQLite file (``seek.db``) recording its
*own* view of the conversation. This is the record layer, written by the
orchestrator in realtime and read-only to the character's agent (via the
``transcript_query`` tool). Because every member writes its own db, a member
only ever sees shared ``send-message`` entries (everyone's speech) plus its OWN
``tool-call`` entries. Another member's tool calls are physically absent here —
that is the multi-agent tool-privacy boundary (no per-viewer filtering needed).

Schema (SQLite STRICT):

    kv                   arbitrary key/value metadata for this character's db.
    transcript_entries   append-only log of ``entry`` JSON rows keyed by seq.
                         ``id`` is the globally unique message id (UNIQUE), so
                         clearing/replaying never duplicates.

``idx_transcript_window`` is a *partial* index that excludes ``tool-call`` rows
so the "recent message window" query (what gets fed to the LLM) never has tool
calls polluting a character's conversational recall of *other* members.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

_SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT
    """,
    """
    CREATE TABLE IF NOT EXISTS transcript_entries (
      seq   INTEGER PRIMARY KEY,
      id    TEXT NOT NULL UNIQUE,
      entry TEXT NOT NULL
    ) STRICT
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_transcript_window
      ON transcript_entries(seq, entry)
      WHERE json_extract(entry, '$.kind') != 'tool-call'
    """,
]

# The kinds a transcript entry may carry (see design §4).
KINDS = ("send-message", "tool-call", "user-attachment", "turn-ended")

# Default window / tail sizes when a caller omits ``limit``.
DEFAULT_WINDOW = 24  # shared across all members (design §10.18)
DEFAULT_TAIL = 100


class TranscriptStore:
    """A per-character seek.db. Open lazily; close it when done.

    ``path`` is the full path to the ``.db`` file. The parent directory is
    created on first use. All operations are serialized on the connection, so a
    single daemon writing to many dbs is fine (each member has its own file).
    """

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self._conn: sqlite3.Connection | None = None

    # -- connection ---------------------------------------------------------
    def _connect(self) -> sqlite3.Connection:
        if self._conn is None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(str(self.path))
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            for stmt in _SCHEMA:
                conn.execute(stmt)
            conn.commit()
            self._conn = conn
        return self._conn

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    def __enter__(self) -> "TranscriptStore":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # -- kv ------------------------------------------------------------------
    def put_kv(self, key: str, value: str) -> None:
        conn = self._connect()
        conn.execute(
            "INSERT INTO kv(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
        conn.commit()

    def get_kv(self, key: str) -> str | None:
        conn = self._connect()
        row = conn.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return row[0] if row else None

    # -- transcript ---------------------------------------------------------
    def append(self, entry: dict[str, Any]) -> int:
        """Insert one transcript entry. Returns its ``seq``.

        ``entry`` must carry a string ``id`` (stable, unique) and a ``kind``.
        The caller serializes the full entry JSON; the only invariant enforced
        here is id-uniqueness (a duplicate id is a no-op update, not an error)
        and kind membership (defensive).
        """
        conn = self._connect()
        entry_id = str(entry.get("id", ""))
        kind = entry.get("kind", "")
        if not entry_id:
            raise ValueError("transcript entry requires an id")
        if kind and kind not in KINDS:
            raise ValueError(f"unknown transcript kind: {kind}")
        payload = json.dumps(entry, ensure_ascii=False)
        cur = conn.execute(
            "INSERT INTO transcript_entries(id, entry) VALUES(?, ?) "
            "ON CONFLICT(id) DO UPDATE SET entry=excluded.entry",
            (entry_id, payload),
        )
        conn.commit()
        return int(cur.lastrowid or 0)

    def _rows_to_entries(self, rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
        return [json.loads(r["entry"]) for r in rows]

    def window(self, limit: int = DEFAULT_WINDOW) -> list[dict[str, Any]]:
        """Most recent ``limit`` *non-tool* entries (the LLM context view).

        This is what gets handed to the orchestrator as a member's message
        history: everyone's shared speech + the member's own history, but no
        tool calls at all (tool calls are a *private* record, surfaced only via
        ``tail`` / ``query`` when the member explicitly asks).
        """
        conn = self._connect()
        rows = conn.execute(
            "SELECT entry FROM transcript_entries "
            "WHERE json_extract(entry, '$.kind') != 'tool-call' "
            "ORDER BY seq DESC LIMIT ?",
            (limit,),
        ).fetchall()
        rows.reverse()
        return self._rows_to_entries(rows)

    def tail(self, limit: int = DEFAULT_TAIL) -> list[dict[str, Any]]:
        """Most recent ``limit`` entries *including* tool calls."""
        conn = self._connect()
        rows = conn.execute(
            "SELECT entry FROM transcript_entries ORDER BY seq DESC LIMIT ?",
            (limit,),
        ).fetchall()
        rows.reverse()
        return self._rows_to_entries(rows)

    def query(
        self,
        *,
        author: str | None = None,
        kind: str | None = None,
        keyword: str | None = None,
        time_start: str | None = None,
        time_end: str | None = None,
        limit: int = DEFAULT_TAIL,
    ) -> list[dict[str, Any]]:
        """Search this member's own transcript with filters.

        Filters:
          - ``author``   : match ``$.author.id`` exactly.
          - ``kind``     : match ``$.kind``.
          - ``keyword``  : case-insensitive substring in the raw entry JSON.
          - ``time_start``/``time_end`` : ISO bounds on ``$.timestampMs``.
        ``limit`` is the max entries returned (oldest-first).

        This is read-only over the member's own db, so it cannot expose other
        members' private tool calls (those were never written here).
        """
        conn = self._connect()
        clauses: list[str] = []
        args: list[Any] = []
        if author is not None:
            clauses.append("json_extract(entry, '$.author.id') = ?")
            args.append(author)
        if kind is not None:
            clauses.append("json_extract(entry, '$.kind') = ?")
            args.append(kind)
        if keyword:
            clauses.append("json_extract(entry, '$') LIKE ? ESCAPE '\\'")
            args.append(f"%{_escape_like(keyword)}%")
        if time_start is not None:
            clauses.append("json_extract(entry, '$.timestampMs') >= ?")
            args.append(time_start)
        if time_end is not None:
            clauses.append("json_extract(entry, '$.timestampMs') <= ?")
            args.append(time_end)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = conn.execute(
            f"SELECT entry FROM transcript_entries{where} ORDER BY seq ASC LIMIT ?",
            (*args, limit),
        ).fetchall()
        return self._rows_to_entries(rows)

    def count(self) -> int:
        conn = self._connect()
        return int(conn.execute("SELECT COUNT(*) FROM transcript_entries").fetchone()[0])


def _escape_like(s: str) -> str:
    """Escape LIKE wildcards so a literal search doesn't match '%'/'_'."""
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
