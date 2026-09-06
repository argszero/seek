"""Embedded static server that serves the built WEBUI bundle.

A Python daemon serves the React bundle built into `webui/dist` so a browser
can open the WEBUI at `http://localhost:<port>` without any external web
server. This runs in a background thread alongside the WebSocket listener.
"""

from __future__ import annotations

import functools
import http.server
import threading
from pathlib import Path


class _Handler(http.server.SimpleHTTPRequestHandler):
    """Serve files; default to index.html for unknown paths (SPA routing)."""

    def __init__(self, *args, directory: Path, **kwargs) -> None:
        super().__init__(*args, directory=str(directory), **kwargs)

    def send_head(self):
        path = self.translate_path(self.path)
        if self.path == "/" or not Path(path).exists():
            self.path = "/index.html"
        return super().send_head()


class WebUiServer:
    """Runs a simple HTTP server over the webui/dist directory in a thread."""

    def __init__(self, webui_dist: str | None = None, host: str = "127.0.0.1",
                 port: int = 37292) -> None:
        self.host = host
        self.port = port
        self.dist = Path(webui_dist) if webui_dist else Path.cwd() / "webui" / "dist"
        self._server: http.server.HTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self.dist.is_dir() and (self.dist / "index.html").exists():
            handler = functools.partial(_Handler, directory=self.dist)
            self._server = http.server.HTTPServer((self.host, self.port), handler)
            self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
            self._thread.start()

    def url(self) -> str | None:
        if self._server:
            return f"http://{self.host}:{self.port}"
        return None
