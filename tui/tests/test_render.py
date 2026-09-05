"""Tests for seek_tui.app message rendering (prefixes, tool cards, system)."""

from seek_tui.app import render_message, truncate, cell_width


def test_user_prefix_cyan():
    line = render_message({"speaker": "user", "kind": "text", "text": "你好"}, [], 40)
    assert line == "> 你好"


def test_virtual_char_by_name():
    chars = [{"id": "c1", "name": "小明"}]
    line = render_message({"speaker": "c1", "kind": "text", "text": "早"}, chars, 40)
    assert line == "● 小明: 早"


def test_unknown_speaker_uses_id():
    line = render_message({"speaker": "c2", "kind": "text", "text": "hi"}, [], 40)
    assert line == "● c2: hi"


def test_system_banner():
    line = render_message({"speaker": "system", "kind": "system", "text": "已清空"}, [], 40)
    assert line == "─── 已清空 ───"


def test_tool_card_success():
    line = render_message({"speaker": "c1", "kind": "tool", "cmd": "read_file",
                           "status": "success", "output": "src/main.py", "text": ""}, [], 60)
    assert "● 🛠 read_file (success)" in line
    assert "src/main.py" in line


def test_tool_card_fail_present():
    line = render_message({"speaker": "c1", "kind": "tool", "cmd": "bash",
                           "status": "fail", "output": "err"}, [], 60)
    assert "(fail)" in line


def test_image_kind():
    line = render_message({"speaker": "c1", "kind": "image", "text": "图"}, [], 40)
    assert "[图片]" in line


def test_truncate_cjk():
    assert truncate("你好abc", 4) == "你好"
    assert truncate("你好世界", 2) == "你"
    assert truncate("你ab", 3) == "你a"


def test_cell_width():
    assert cell_width("你") == 2
    assert cell_width("a") == 1
