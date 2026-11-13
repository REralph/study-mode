"""The shared read-modify-write layer over the state file.

The service ticks the countdown; the desktop app issues commands; the native host reads the
status. They run in different processes, so every change goes load -> transform -> save
while holding a cross-process file lock, and each command is logged. Keeping all mutation
here means the service and app can never drift apart.
"""

from __future__ import annotations

import logging
import time
from contextlib import contextmanager
from logging.handlers import RotatingFileHandler
from typing import Any, Callable, Dict

from . import paths, state as state_mod, store

try:
    import msvcrt  # Windows file locking
except ImportError:  # pragma: no cover - non-Windows (tests of pure logic still run)
    msvcrt = None

_logger: logging.Logger | None = None


def get_logger() -> logging.Logger:
    global _logger
    if _logger is None:
        log = logging.getLogger("studymode.protection")
        log.setLevel(logging.INFO)
        if not log.handlers:
            try:
                paths.log_file().parent.mkdir(parents=True, exist_ok=True)
                handler: logging.Handler = RotatingFileHandler(
                    paths.log_file(), maxBytes=512_000, backupCount=3, encoding="utf-8")
            except OSError:
                handler = logging.StreamHandler()
            handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
            log.addHandler(handler)
        _logger = log
    return _logger


@contextmanager
def _lock():
    """A simple cross-process lock held via an exclusive handle on a lock file."""
    paths.home().mkdir(parents=True, exist_ok=True)
    lock_path = paths.home() / "state.lock"
    fh = open(lock_path, "a+")
    try:
        if msvcrt is not None:
            for _ in range(100):  # up to ~5 s
                try:
                    msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    time.sleep(0.05)
        yield
    finally:
        try:
            if msvcrt is not None:
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
        fh.close()


def _update(fn: Callable[[Dict[str, Any]], Dict[str, Any]], description: str) -> Dict[str, Any]:
    with _lock():
        current = store.load_state()
        updated = fn(current)
        store.save_state(updated)
    if description:
        get_logger().info("%s -> status=%s request=%s", description,
                           updated.get("status"), (updated.get("request") or {}).get("status"))
    return updated


# -- Commands from the desktop app (each logged) ---------------------------------------

def request_deactivation() -> Dict[str, Any]:
    return _update(state_mod.request_deactivation, "Deactivation requested")


def cancel_request() -> Dict[str, Any]:
    return _update(state_mod.cancel_request, "Request cancelled")


def pause(pause_seconds: int) -> Dict[str, Any]:
    return _update(lambda s: state_mod.pause(s, pause_seconds), f"Protection paused for {pause_seconds}s")


def remove() -> Dict[str, Any]:
    return _update(state_mod.remove, "Protection removed")


def activate() -> Dict[str, Any]:
    return _update(state_mod.activate, "Protection activated")


def set_required_seconds(seconds: int) -> Dict[str, Any]:
    cfg = store.load_config()
    cfg["required_seconds"] = int(seconds)
    store.save_config(cfg)
    return _update(lambda s: state_mod.set_required_seconds(s, seconds), f"Waiting period set to {seconds}s")


# -- Heartbeat from the service --------------------------------------------------------

def heartbeat(now: float | None = None, max_tick: float | None = None) -> Dict[str, Any]:
    now = time.time() if now is None else now
    mt = state_mod.MAX_TICK_SECONDS if max_tick is None else max_tick
    return _update(lambda s: state_mod.tick(s, now, mt), "")


# -- Reads (no lock needed; a stale read is harmless) ----------------------------------

def read_state() -> Dict[str, Any]:
    return store.load_state()


def read_summary() -> Dict[str, Any]:
    return state_mod.summary(store.load_state())
