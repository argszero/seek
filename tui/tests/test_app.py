"""Tests for seek_tui.app pure helpers (title/session/role logic)."""

from seek_tui import widgets as seek_widgets
from seek_tui.app import (
    CHAR_SEEK_ID,
    ROOM_SEEK_ID,
    SEEK_COMMAND_HELP,
    auto_title_from_prompt,
    count_text_messages,
    is_system_message,
    is_user_speaker,
    role_of,
    session_label,
    short_id,
    sort_sessions,
)
from seek_tui.python_tui.widgets.base import RenderContext
from seek_tui.widgets import ChatHistory, CommandDropdown


def test_auto_title_from_prompt_plain():
    assert auto_title_from_prompt("你好世界") == "你好世界"


def test_auto_title_from_prompt_truncates_cjk():
    # 30-char cap (display chars, not bytes).
    t = auto_title_from_prompt("你" * 40, max_len=30)
    assert t is not None
    assert len(t) == 30  # 29 chars + ellipsis
    assert t.endswith("…")


def test_auto_title_from_prompt_ignores_commands_and_blank():
    assert auto_title_from_prompt("/help 帮我看看") is None
    assert auto_title_from_prompt("   \n  ") is None
    assert auto_title_from_prompt("") is None


def test_auto_title_takes_first_line():
    assert auto_title_from_prompt("第一行\n第二行") == "第一行"


def test_short_id():
    assert short_id("0123456789abcdef", 6) == "012345"
    assert short_id("") == ""
    assert short_id("abc", 8) == "abc"


def test_session_label():
    assert session_label({"name": "读研#2"}) == "读研#2"
    assert session_label({"name": "", "id": "0123456789"}) == "01234567"
    assert session_label({}) == "?"
    assert session_label(None) == "?"


def test_sort_sessions_newest_first():
    sessions = [
        {"id": "old", "updatedAt": "2026-09-01T00:00:00"},
        {"id": "new", "updatedAt": "2026-09-07T09:00:00"},
        {"id": "mid", "updatedAt": "2026-09-03T00:00:00"},
    ]
    assert [s["id"] for s in sort_sessions(sessions)] == ["new", "mid", "old"]


def test_role_of_mapping():
    assert role_of({"kind": "text", "speaker": "user"}) == "user"
    assert role_of({"kind": "text", "speaker": "you"}) == "user"
    assert role_of({"kind": "text", "speaker": CHAR_SEEK_ID}) == "assistant"
    assert role_of({"kind": "text", "speaker": "system"}) == "system"
    assert role_of({"kind": "system", "speaker": "seek"}) == "system"
    assert role_of({"kind": "tool", "speaker": CHAR_SEEK_ID,
                    "cmd": "bash"}) == "tool"


def test_is_user_speaker_and_system():
    assert is_user_speaker("user")
    assert is_user_speaker("you")
    assert not is_user_speaker("seek")
    assert is_system_message({"kind": "system", "speaker": "seek"})
    assert is_system_message({"kind": "text", "speaker": "system"})
    assert not is_system_message({"kind": "text", "speaker": "user"})


def test_count_text_messages():
    msgs = [
        {"kind": "text", "speaker": "user"},
        {"kind": "text", "speaker": CHAR_SEEK_ID},
        {"kind": "tool", "speaker": CHAR_SEEK_ID, "cmd": "bash"},
        {"kind": "system", "speaker": "system"},
    ]
    assert count_text_messages(msgs) == 2


def test_seek_command_help_is_emrg_subset():
    # seek exposes no /rant /memory /skills /image /compact /rewind.
    for forbidden in ("/rant", "/memory", "/skills", "/image",
                      "/compact", "/rewind"):
        assert forbidden not in SEEK_COMMAND_HELP
    for required in ("/help", "/sessions", "/resume", "/rename",
                     "/delete", "/clear", "/model", "/new", "/version",
                     "/stop"):
        assert required in SEEK_COMMAND_HELP


def test_command_dropdown_uses_seek_commands():
    # The dropdown widget reads module-level _COMMAND_HELP, which app.py
    # redirects to seek's command set at import time.
    dd = CommandDropdown(prefix="/m")
    assert dd._matching == ["/model"]
    assert dd.selected_command == "/model"
    dd2 = CommandDropdown(prefix="/s")
    assert set(dd2._matching) == {"/sessions", "/stop"}


def test_chat_history_adds_user_markdown_row():
    from seek_tui.python_tui.widgets.markdown import UserMarkdown

    chat = ChatHistory()
    chat.add("user", "你好")
    assert isinstance(chat.rows[0], UserMarkdown)


def test_chat_history_roles_render_prefixes():
    from seek_tui.python_tui.widgets.base import Span
    from seek_tui.python_tui.widgets.chat_row import ChatRow

    chat = ChatHistory()
    chat.add("assistant", "回复")
    chat.add("system", "已清空")
    assert isinstance(chat.rows[0], ChatRow)
    assert isinstance(chat.rows[1], ChatRow)
    lines = chat.render(RenderContext(80))
    joined = "\n".join("".join(sp.text for sp in ln.spans) for ln in lines)
    assert joined.startswith("● 回复")
    assert "○ 已清空" in joined


def test_room_constants():
    assert ROOM_SEEK_ID == "room-seek"
    assert CHAR_SEEK_ID == "seek"
