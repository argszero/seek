"""seek configuration loading.

Reads ``~/.seek/config.toml`` (mirroring EMRG's ``~/.emrg/config.toml`` layout).
If the seek config does not exist yet, falls back to the EMRG config so seek can
reuse an already-configured LLM endpoint for local testing. Override the data
root with ``SEEK_HOME`` and the config path with ``SEEK_CONFIG``.
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class LlmConfig:
    """LLM endpoint settings, aligned with EMRG's ``[llm]`` table."""

    base_url: str = "https://api.openai.com/v1"
    api_key: str = ""
    model: str = "gpt-4o-mini"
    max_tokens: int = 8192
    temperature: float = 0.7
    context_window: int | None = None
    vision: bool = False
    models: list[dict] = field(default_factory=list)


def config_dir() -> Path:
    """The seek data directory (~/.seek, or $SEEK_HOME)."""
    env = os.environ.get("SEEK_HOME")
    return Path(env).expanduser() if env else Path.home() / ".seek"


def config_path() -> Path:
    """The seek config file (~/.seek/config.toml, or $SEEK_CONFIG)."""
    env = os.environ.get("SEEK_CONFIG")
    if env:
        return Path(env).expanduser()
    return config_dir() / "config.toml"


def _emrg_config_path() -> Path:
    return Path.home() / ".emrg" / "config.toml"


def _load_llm_table(doc: dict) -> dict:
    llm = doc.get("llm", {})
    return {
        "base_url": llm.get("base_url", "https://api.openai.com/v1"),
        "api_key": llm.get("api_key", llm.get("api_key_1", llm.get("api_key_2", ""))),
        "model": llm.get("model", "gpt-4o-mini"),
        "max_tokens": llm.get("max_tokens", 8192),
        "temperature": llm.get("temperature", 0.7),
        "context_window": llm.get("context_window"),
        "vision": llm.get("vision", False),
        "models": llm.get("models", []),
    }


def load_config() -> LlmConfig:
    """Load the LLM config from seek, falling back to the EMRG config."""
    for cand in (config_path(), _emrg_config_path()):
        if not cand.exists():
            continue
        try:
            doc = tomllib.loads(cand.read_text(encoding="utf-8"))
        except Exception:
            continue
        data = _load_llm_table(doc)
        return LlmConfig(**data)
    return LlmConfig()


# ---- config write-back (only the LLM block; preserves other TOML sections) ----

def _is_scalar(v) -> bool:
    return isinstance(v, (str, int, float, bool)) or v is None


def _quote(v: str) -> str:
    # Escape backslashes, quotes, newlines for a double-quoted TOML string.
    esc = (v.replace("\\", "\\\\")
            .replace('"', '\\"')
            .replace("\n", "\\n")
            .replace("\t", "\\t"))
    return f'"{esc}"'


def _toml_lines(doc: dict, prefix: str = "") -> list[str]:
    """Serialize a dict to TOML lines.

    ``prefix`` is the dotted path of an already-open ``[section]``. Scalars inside
    an open section are emitted bare (``key = v``); nested tables/arrays of tables
    use ``[prefix.key]`` / ``[[prefix.key]]``.
    """
    out: list[str] = []
    scalars: list[str] = []
    tables: list[tuple[str, dict]] = []
    arrays: list[tuple[str, list]] = []
    for k, v in doc.items():
        if _is_scalar(v):
            if v is None:
                scalars.append(f"{k} = " + _quote(""))
            elif isinstance(v, bool):
                scalars.append(f"{k} = " + ("true" if v else "false"))
            elif isinstance(v, (int, float)):
                scalars.append(f"{k} = {v}")
            else:
                scalars.append(f"{k} = " + _quote(str(v)))
        elif isinstance(v, list):
            arrays.append((k, v))
        elif isinstance(v, dict):
            tables.append((k, v))

    out.extend(scalars)
    # Arrays first (so scalar keys stay grouped), then nested tables.
    for key, arr in arrays:
        dotted = f"{prefix}.{key}" if prefix else key
        if all(_is_scalar(x) for x in arr):
            values = ", ".join(_toml_scalar(x) for x in arr)
            out.append(f"{dotted} = [{values}]")
        else:
            out.append("")
            for item in arr:
                out.append(f"[[{dotted}]]")
                out.extend(_toml_lines(item, ""))
    for key, sub in tables:
        dotted = f"{prefix}.{key}" if prefix else key
        out.append("")
        out.append(f"[{dotted}]")
        out.extend(_toml_lines(sub, dotted))
    return out


def _toml_scalar(v) -> str:
    if v is None:
        return _quote("")
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    return _quote(str(v))


def save_llm_config(cfg: LlmConfig) -> Path:
    """Write the LLM config back to ``~/.seek/config.toml``.

    Reads the existing config (preserving comments/unknown sections is not
    supported beyond a full round-trip of parsed TOML), merges the ``[llm]``
    block from ``cfg``, and writes it back. Returns the written path.
    """
    path = config_path()
    doc: dict = {}
    if path.exists():
        try:
            doc = tomllib.loads(path.read_text(encoding="utf-8"))
        except Exception:
            doc = {}
    # Replace the [llm] block wholesale with cfg fields.
    llm: dict[str, Any] = {
        "base_url": cfg.base_url,
        "api_key": cfg.api_key,
        "model": cfg.model,
        "max_tokens": cfg.max_tokens,
        "temperature": cfg.temperature,
    }
    if cfg.context_window is not None:
        llm["context_window"] = cfg.context_window
    if cfg.vision:
        llm["vision"] = cfg.vision
    if cfg.models:
        llm["models"] = cfg.models
    doc["llm"] = llm
    path.parent.mkdir(parents=True, exist_ok=True)
    body = "\n".join(_toml_lines(doc, "")) + "\n"
    path.write_text(body, encoding="utf-8")
    return path
