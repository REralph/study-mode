"""Reading and writing the protection state as JSON, safely.

The service, the desktop app and the native host all touch the same files, so writes are
atomic (write a temp file, then replace) and reads tolerate a half-written or missing file
by falling back to a fresh state. This is deliberately simple and dependency-free.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any, Dict

from . import paths, state as state_mod


def _read_json(path: Path) -> Dict[str, Any] | None:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def _write_json(path: Path, data: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Replace in the same directory so os.replace is atomic (same filesystem).
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def load_config() -> Dict[str, Any]:
    cfg = _read_json(paths.config_file()) or {}
    cfg.setdefault("required_seconds", state_mod.DEFAULT_REQUIRED_SECONDS)
    cfg.setdefault("heartbeat_seconds", state_mod.DEFAULT_HEARTBEAT_SECONDS)
    return cfg


def save_config(cfg: Dict[str, Any]) -> None:
    _write_json(paths.config_file(), cfg)


def load_state() -> Dict[str, Any]:
    """The stored state, or a fresh one seeded from config if nothing valid is stored."""
    data = _read_json(paths.state_file())
    if not data or data.get("version") != state_mod.STATE_VERSION or "status" not in data:
        return state_mod.new_state(load_config()["required_seconds"])
    return data


def save_state(state: Dict[str, Any]) -> None:
    _write_json(paths.state_file(), state)
