"""Protection state machine and countdown logic for Study Mode.

Pure logic: no Windows APIs, no file I/O, no clock of its own. The caller passes the
current monotonic-ish timestamp in, so every rule here is deterministic and testable.

Why time is passed in, and why it accumulates
---------------------------------------------
The user chose "the waiting period counts only while the PC is switched on". The service
calls ``tick(now)`` on a heartbeat while it runs; the gap between two heartbeats is the
time the PC was on. A gap far larger than the heartbeat interval means the PC was off,
asleep, or the service was stopped, so it is clamped to one interval and effectively does
not count. Clock going backwards counts as zero. Both make the wait *longer*, never
shorter, which is the safe direction.

The state is a plain dict so it can be stored as JSON. ``new_state`` creates one;
every transition returns a new dict and never mutates its argument.
"""

from __future__ import annotations

import copy
from typing import Any, Dict, Optional

# Status values for the protection itself.
ACTIVE = "active"        # blocking is on
PAUSED = "paused"        # temporarily off; returns to ACTIVE after a pause window
REMOVED = "removed"      # deliberately turned off until the user re-activates

# Status values for a pending deactivation request (state["request"]["status"]).
WAITING = "waiting"      # counting down
READY = "ready"          # the waiting period has elapsed; the user may now pause or remove

DEFAULT_REQUIRED_SECONDS = 2 * 3600 + 40 * 60  # 2 h 40 m
DEFAULT_HEARTBEAT_SECONDS = 10
# A gap longer than this between heartbeats is treated as "PC was off" and clamped.
# One heartbeat plus a generous grace, so normal scheduling jitter still counts in full.
MAX_TICK_SECONDS = DEFAULT_HEARTBEAT_SECONDS * 3

STATE_VERSION = 1


def new_state(required_seconds: int = DEFAULT_REQUIRED_SECONDS) -> Dict[str, Any]:
    """A fresh state with protection active and no pending request."""
    return {
        "version": STATE_VERSION,
        "status": ACTIVE,
        "required_seconds": int(required_seconds),
        # Total on-time accumulated by tick(); monotonic, never reset. All deadlines are
        # expressed as a value of this counter, so they are immune to wall-clock changes.
        "active_seconds": 0.0,
        "last_tick": None,       # wall-clock timestamp of the last heartbeat, for gap detection
        "request": None,         # pending deactivation request, or None
        "pause_until_active": None,  # active_seconds at which a PAUSE ends
    }


def _clamp_elapsed(now: float, last_tick: Optional[float], max_tick: float) -> float:
    """On-time to add for this heartbeat: never negative, never more than one interval."""
    if last_tick is None:
        return 0.0
    elapsed = now - last_tick
    if elapsed <= 0:
        return 0.0
    return min(elapsed, max_tick)


def tick(state: Dict[str, Any], now: float, max_tick: float = MAX_TICK_SECONDS) -> Dict[str, Any]:
    """Advance on-time by the clamped gap since the last heartbeat and apply time-based
    transitions (WAITING -> READY, and PAUSED -> ACTIVE). Call this every heartbeat."""
    s = copy.deepcopy(state)
    s["active_seconds"] = float(s.get("active_seconds", 0.0)) + _clamp_elapsed(now, s.get("last_tick"), max_tick)
    s["last_tick"] = now

    req = s.get("request")
    if req and req.get("status") == WAITING and s["active_seconds"] >= req["ready_at_active"]:
        req["status"] = READY

    if s["status"] == PAUSED and s.get("pause_until_active") is not None:
        if s["active_seconds"] >= s["pause_until_active"]:
            s["status"] = ACTIVE
            s["pause_until_active"] = None
    return s


def request_deactivation(state: Dict[str, Any]) -> Dict[str, Any]:
    """Begin the waiting period. No-op if protection is already off or a request exists."""
    s = copy.deepcopy(state)
    if s["status"] != ACTIVE or s.get("request"):
        return s
    s["request"] = {
        "status": WAITING,
        "requested_at_active": s["active_seconds"],
        "ready_at_active": s["active_seconds"] + s["required_seconds"],
    }
    return s


def cancel_request(state: Dict[str, Any]) -> Dict[str, Any]:
    """Drop a pending request (whether WAITING or READY). Protection stays as it was."""
    s = copy.deepcopy(state)
    s["request"] = None
    return s


def pause(state: Dict[str, Any], pause_seconds: int) -> Dict[str, Any]:
    """Turn protection off for ``pause_seconds`` of on-time. Only allowed once a request
    is READY. Protection reactivates by itself (see ``tick``)."""
    s = copy.deepcopy(state)
    req = s.get("request")
    if not req or req.get("status") != READY:
        raise PermissionError("The waiting period is not over yet.")
    if pause_seconds <= 0:
        raise ValueError("Pause duration must be positive.")
    s["status"] = PAUSED
    s["pause_until_active"] = s["active_seconds"] + int(pause_seconds)
    s["request"] = None
    return s


def remove(state: Dict[str, Any]) -> Dict[str, Any]:
    """Turn protection off until the user re-activates. Only allowed once READY."""
    s = copy.deepcopy(state)
    req = s.get("request")
    if not req or req.get("status") != READY:
        raise PermissionError("The waiting period is not over yet.")
    s["status"] = REMOVED
    s["pause_until_active"] = None
    s["request"] = None
    return s


def activate(state: Dict[str, Any]) -> Dict[str, Any]:
    """Turn protection back on at once and clear any request or pause. Re-enabling
    protection is always immediate; only turning it *off* waits."""
    s = copy.deepcopy(state)
    s["status"] = ACTIVE
    s["request"] = None
    s["pause_until_active"] = None
    return s


def set_required_seconds(state: Dict[str, Any], required_seconds: int) -> Dict[str, Any]:
    """Change the configured waiting period.

    A longer period takes effect immediately, including for a pending request. A shorter
    period must not let the user shorten a wait they have already started, so for an active
    request the ready point only ever moves later, never earlier."""
    if required_seconds <= 0:
        raise ValueError("The waiting period must be positive.")
    s = copy.deepcopy(state)
    old = s["required_seconds"]
    s["required_seconds"] = int(required_seconds)
    req = s.get("request")
    if req and req.get("status") == WAITING:
        if required_seconds > old:
            req["ready_at_active"] = req["requested_at_active"] + required_seconds
    return s


def is_blocking(state: Dict[str, Any]) -> bool:
    """Whether the extension should be blocking right now."""
    return state.get("status") == ACTIVE


def remaining_seconds(state: Dict[str, Any]) -> Optional[float]:
    """On-time left before a pending request is READY, 0 if READY, or None if no request."""
    req = state.get("request")
    if not req:
        return None
    if req.get("status") == READY:
        return 0.0
    return max(0.0, req["ready_at_active"] - state["active_seconds"])


def pause_remaining_seconds(state: Dict[str, Any]) -> Optional[float]:
    """On-time left on a pause, or None if not paused."""
    if state.get("status") != PAUSED or state.get("pause_until_active") is None:
        return None
    return max(0.0, state["pause_until_active"] - state["active_seconds"])


def summary(state: Dict[str, Any]) -> Dict[str, Any]:
    """A small, display-ready view of the state for the UI and the extension."""
    return {
        "status": state.get("status"),
        "blocking": is_blocking(state),
        "required_seconds": state.get("required_seconds"),
        "request_status": (state.get("request") or {}).get("status"),
        "remaining_seconds": remaining_seconds(state),
        "pause_remaining_seconds": pause_remaining_seconds(state),
    }
