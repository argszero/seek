"""Tests for seek_tui.app pure text helpers (CJK-aware width/truncate)."""

from seek_tui.app import _disp_width, truncate


def test_disp_width_cjk_is_2():
    assert _disp_width("你") == 2
    assert _disp_width("a") == 1
    assert _disp_width("中") == 2


def test_truncate_by_width():
    # 4 columns → 2 CJK chars fit.
    assert truncate("你好abc", 4) == "你好"
    # ASCII fits fully when enough space.
    assert truncate("hello", 10) == "hello"
    # 2 columns → exactly one CJK char.
    assert truncate("你好世界", 2) == "你"
    # No width → empty.
    assert truncate("anything", 0) == ""


def test_truncate_does_not_break_mid_char():
    # 3 columns can hold one CJK char (2) + one ASCII (1).
    assert truncate("你ab", 3) == "你a"
    # 1 column cannot hold a CJK char (width 2) → empty.
    assert truncate("你", 1) == ""
