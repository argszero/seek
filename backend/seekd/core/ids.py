"""Small id/time helpers shared across the backend."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone


def new_id() -> str:
    """A fresh UUID (v4, lowercase hex)."""
    return str(uuid.uuid4())


def now_iso() -> str:
    """The current UTC time as an ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat()
