"""Tests for seek_tui.app message-to-row mapping (renderer helpers)."""

from seek_tui.app import (
    CHAR_SEEK_ID,
    message_to_row,
    role_of,
)
from seek_tui.python_tui.widgets.tool_card import ToolCard
from seek_tui.widgets import ChatHistory


def test_user_row_cyan_prefix_shape():
    role, text = message_to_row({"speaker": "user", "kind": "text", "text": "你好"}, [])
    assert (role, text) == ("user", "你好")


def test_virtual_char_by_name():
    chars = [{"id": "c1", "name": "小明"}]
    role, text = message_to_row({"speaker": "c1", "kind": "text", "text": "早"}, chars)
    assert role == "assistant"
    assert text == "小明: 早"


def test_builtin_seek_no_name_prefix():
    role, text = message_to_row(
        {"speaker": CHAR_SEEK_ID, "kind": "text", "text": "你好"}, [])
    assert role == "assistant"
    assert text == "你好"


def test_unknown_speaker_uses_id():
    role, text = message_to_row({"speaker": "c2", "kind": "text", "text": "hi"}, [])
    assert role == "assistant"
    assert text == "c2: hi"


def test_system_banner():
    role, text = message_to_row(
        {"speaker": "system", "kind": "system", "text": "已清空"}, [])
    assert role == "system"
    assert text == "已清空"


def test_tool_message_maps_to_tool_role():
    role, _ = message_to_row(
        {"speaker": "c1", "kind": "tool", "cmd": "read_file",
         "status": "success", "output": "src/main.py"}, [])
    assert role == "tool"


def test_tool_message_appends_tool_card():
    app_rows = _rows_for([
        {"speaker": CHAR_SEEK_ID, "kind": "tool", "cmd": "bash",
         "status": "success", "output": "ok"},
        {"speaker": CHAR_SEEK_ID, "kind": "text", "text": "完成"},
    ])
    assert isinstance(app_rows[0], ToolCard)
    assert app_rows[0].status == "done"
    assert app_rows[0].output == "ok"


def test_tool_fail_card_status():
    app_rows = _rows_for([
        {"speaker": CHAR_SEEK_ID, "kind": "tool", "cmd": "bash",
         "status": "fail", "output": "err"},
    ])
    assert app_rows[0].status == "failed"


def _rows_for(messages):
    """Append messages to a ChatHistory the same way SeekApp._render_message
    does (row role selection + widget kind), returning the added row list."""
    chat = ChatHistory()
    n0 = len(chat.rows)
    for msg in messages:
        role, text = message_to_row(msg, [])
        if role == "tool":
            cmd = msg.get("cmd", "") or "tool"
            chat.add(ToolCard(name=cmd, command=cmd,
                              status="failed" if msg.get("status") == "fail" else "done",
                              output=msg.get("output", "") or "", expanded=False))
        else:
            chat.add(role, text)
    return chat.rows[n0:]
