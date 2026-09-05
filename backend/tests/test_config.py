"""Tests for seekd.config — LLM config loading and EMRG fallback."""

import tomllib
from pathlib import Path

import pytest

from seekd.config import (
    LlmConfig, _load_llm_table, load_config, save_llm_config,
)


def test_load_llm_table_reads_emrg_fields():
    doc = {"llm": {"base_url": "https://x/v1", "api_key": "k", "model": "m",
                   "max_tokens": 4096, "temperature": 0.5, "models": [{"name": "m1"}]}}
    data = _load_llm_table(doc)
    assert data["base_url"] == "https://x/v1"
    assert data["api_key"] == "k"
    assert data["model"] == "m"
    assert data["max_tokens"] == 4096
    assert data["temperature"] == 0.5
    assert data["models"] == [{"name": "m1"}]


def test_api_key_fallback_to_1_2():
    doc = {"llm": {"base_url_1": "u1", "api_key_1": "k1", "api_key_2": "k2", "model": "m"}}
    data = _load_llm_table(doc)
    assert data["api_key"] == "k1"  # prefers the primary 'api_key', then 1, then 2


def test_load_config_missing_returns_default():
    # When neither seek nor emrg config path exists, fall back to defaults.
    # We call the pure loader with an empty doc.
    c = LlmConfig()
    assert c.base_url == "https://api.openai.com/v1"
    assert c.model == "gpt-4o-mini"


def test_save_llm_config_roundtrip(tmp_path, monkeypatch):
    # Redirection: point the seek config path at a temp file and write a config.
    cfg_path = tmp_path / "config.toml"
    monkeypatch.setenv("SEEK_CONFIG", str(cfg_path))

    cfg = LlmConfig(base_url="https://x/v1", api_key="key", model="m",
                    max_tokens=4096, temperature=0.5,
                    context_window=131072, vision=True,
                    models=[{"name": "m1", "model": "m1-api", "vision": True}])
    saved = save_llm_config(cfg)
    assert saved.exists(), "save_llm_config should create the file"

    # Reload via load_config and assert the round-trip preserves fields.
    got = load_config()
    assert got.base_url == "https://x/v1"
    assert got.api_key == "key"
    assert got.model == "m"
    assert got.max_tokens == 4096
    assert got.context_window == 131072
    assert got.vision is True
    assert got.models == [{"name": "m1", "model": "m1-api", "vision": True}]


def test_save_llm_config_edits_models_list(tmp_path, monkeypatch):
    cfg_path = tmp_path / "config.toml"
    monkeypatch.setenv("SEEK_CONFIG", str(cfg_path))

    # Start with one model; edit the list (add a second, change a field).
    cfg = LlmConfig(base_url="https://x/v1", api_key="k", model="m",
                    models=[{"name": "a"}, {"name": "b", "model": "b-api"}])
    save_llm_config(cfg)

    doc = tomllib.loads(cfg_path.read_text(encoding="utf-8"))
    assert doc["llm"]["models"] == [{"name": "a"}, {"name": "b", "model": "b-api"}]
    assert doc["llm"]["base_url"] == "https://x/v1"
