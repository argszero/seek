"""Memory directory store — an index (MEMORY.md) + detail files per character.

Each character owns two memory *directories*:
  - session-level (primary): ``rooms/<roomId>/sessions/<sid>/<characterId>/memory/``
  - global (secondary)    : ``characters/<characterId>/memory/``

A memory directory is: a link-style index ``MEMORY.md`` (one summary line per
memory, pointing at a detail file) plus the detail files themselves, which the
character may organize freely (topic files, subdirectories, dates). We only
establish the format and helpers; *when/what* a character reads or writes is
entirely its own decision (see design §7).

All access here is relative to a single memory directory, so permission is
enforced at the call site by constructing this helper only for the member's own
two directories (the memory tools receive the owning character's scope).
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

INDEX_NAME = "MEMORY.md"
_MAX_SUMMARY = 512

# A memory index line: ``- <summary> -> <relative detail path>`` (link style A).
_INDEX_LINE_RE = re.compile(r"^-\s+(.+?)\s*(?:->\s*(.+))?\s*$")


class MemoryStore:
    """Read/write one memory directory (index + detail files)."""

    def __init__(self, directory: Path | str) -> None:
        self.dir = Path(directory)

    # -- paths ---------------------------------------------------------------
    @property
    def index_path(self) -> Path:
        return self.dir / INDEX_NAME

    def detail_path(self, topic: str) -> Path:
        """Resolve a relative detail path inside the memory directory.

        ``topic`` may contain a subdirectory (e.g. ``others/小明.md``). It is
        resolved *inside* the memory dir and must not escape it.
        Raises ``ValueError`` on a path-traversal attempt.
        """
        rel = Path(topic)
        if rel.is_absolute() or ".." in rel.parts:
            raise ValueError(f"invalid memory topic: {topic!r}")
        return self.dir / rel

    def _ensure_root(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)

    # -- index ---------------------------------------------------------------
    def read_index(self) -> list[dict[str, str]]:
        """Parse MEMORY.md into ``[{summary, path}]`` rows (or [] if none)."""
        if not self.index_path.exists():
            return []
        entries: list[dict[str, str]] = []
        for line in self.index_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line.startswith("- "):
                continue
            m = _INDEX_LINE_RE.match(line)
            if not m:
                continue
            summary = m.group(1).strip()
            detail = (m.group(2) or "").strip()
            entries.append({"summary": summary, "path": detail})
        return entries

    def index_text(self) -> str:
        """The raw MEMORY.md content, or a placeholder if the file is empty."""
        if not self.index_path.exists():
            return "(no memories yet)"
        text = self.index_path.read_text(encoding="utf-8").strip()
        return text or "(no memories yet)"

    def write_index(self, entries: list[dict[str, str]]) -> None:
        """Rewrite MEMORY.md from a list of ``{summary, path}`` rows."""
        self._ensure_root()
        lines: list[str] = []
        for e in entries:
            summary = e.get("summary", "").strip()[:_MAX_SUMMARY]
            path = e.get("path", "").strip()
            line = f"- {summary}"
            if path:
                line += f" -> {path}"
            lines.append(line)
        body = "\n".join(lines) + ("\n" if lines else "")
        self.index_path.write_text(body, encoding="utf-8")

    def ensure_index(self) -> None:
        """Create an empty MEMORY.md if it does not already exist."""
        self._ensure_root()
        if not self.index_path.exists():
            self.index_path.write_text("", encoding="utf-8")

    # -- details -------------------------------------------------------------
    def read_detail(self, topic: str) -> str:
        """Read a detail file's content as text. ``topic`` is the relative path."""
        p = self.detail_path(topic)
        if not p.exists() or not p.is_file():
            raise FileNotFoundError(f"memory detail not found: {topic!r}")
        return p.read_text(encoding="utf-8")

    def write_detail(self, topic: str, content: str) -> Path:
        """Write/overwrite a detail file (creating subdirectories). Returns path."""
        p = self.detail_path(topic)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return p

    def delete_detail(self, topic: str) -> bool:
        """Delete a detail file. Returns True if it existed."""
        p = self.detail_path(topic)
        if p.exists() and p.is_file():
            p.unlink()
            return True
        return False

    # -- search --------------------------------------------------------------
    def search(self, query: str, limit: int = 20) -> list[dict[str, str]]:
        """Scan the index for memories whose summary or path matches ``query``.

        Returns ``[{summary, path}]`` rows (capped at ``limit``). This is a
        *lightweight* index scan — it does NOT read detail bodies. A character
        wanting to inspect a hit's body should call ``read_detail`` next.
        """
        q = query.strip().lower()
        if not q:
            return []
        hits: list[dict[str, str]] = []
        for e in self.read_index():
            if q in e.get("summary", "").lower() or q in e.get("path", "").lower():
                hits.append(e)
                if len(hits) >= limit:
                    break
        return hits
