"""Tests for seekd.tools — bash, read, write, edit, glob, grep, registry."""

import asyncio
from pathlib import Path

from seekd.tools.bash_tool import BashTool
from seekd.tools.edit_tool import EditTool
from seekd.tools.glob_tool import GlobTool
from seekd.tools.grep_tool import GrepTool
from seekd.tools.read_tool import ReadTool
from seekd.tools.registry import default_tools, tool_specs
from seekd.tools.write_tool import WriteTool


def _run(coro):
    return asyncio.run(coro)


def test_bash_echo():
    r = _run(BashTool().execute({"command": "echo hello", "intent": "test"}))
    assert r.error is False
    assert "hello" in r.content


def test_bash_timeout():
    r = _run(BashTool().execute({"command": "sleep 5", "timeout": 1, "intent": "test"}))
    assert r.error is True
    assert "timed out" in r.content.lower()


def test_read_write_edit(tmp_path):
    f = tmp_path / "a.txt"
    w = _run(WriteTool().execute({"file_path": str(f), "content": "line1\nline2\nline3", "intent": "t"}))
    assert w.error is False
    r = _run(ReadTool().execute({"file_path": str(f), "intent": "t"}))
    assert "line2" in r.content
    e = _run(EditTool().execute({"file_path": str(f), "old_string": "line2", "new_string": "LINE2", "intent": "t"}))
    assert e.error is False
    assert "LINE2" in f.read_text()


def test_read_disallows_relative(tmp_path):
    r = _run(ReadTool().execute({"file_path": "relative.txt", "intent": "t"}))
    assert r.error is True


def test_glob_and_grep(tmp_path):
    (tmp_path / "x.py").write_text("import os\n\n\ndef foo():\n    pass\n")
    (tmp_path / "y.py").write_text("import sys\n")
    g = _run(GlobTool().execute({"pattern": "*.py", "workdir": str(tmp_path), "intent": "t"}))
    assert "x.py" in g.content
    gr = _run(GrepTool().execute({"pattern": "def foo", "path": str(tmp_path), "intent": "t"}))
    assert "x.py" in gr.content
    assert "def foo" in gr.content


def test_default_tool_specs():
    tools = default_tools()
    names = {t.definition().name for t in tools}
    assert names == {"bash", "read", "write", "edit", "glob", "grep"}
    specs = tool_specs(tools)
    assert all(s.name in names for s in specs)
