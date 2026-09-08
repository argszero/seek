"""seekd store subpackage — world entities + per-character transcript/memory.

``store.SeekStore`` is the hierarchical entity store (characters/rooms/sessions/
tasks). ``store.transcript.TranscriptStore`` is a single member's SQLite seek.db.
``store.memory.MemoryStore`` is a single character's memory directory.
"""

from seekd.store.store import SeekStore

__all__ = ["SeekStore"]
