"""Native-messaging host: lets the Firefox extension read the protection status.

Firefox launches this process and talks to it over stdin/stdout using its native-messaging
framing: a 4-byte little-endian length followed by that many bytes of UTF-8 JSON. The
extension sends ``{"type": "getStatus"}`` and gets back the current status, the countdown,
and any integrity problems/warnings, so the popup can show the truth from the service
rather than from the extension's own storage.

The extension can *read* status here but cannot change it: there is deliberately no command
that turns protection off. Turning it off only happens in the desktop app, behind the wait.
"""

from __future__ import annotations

import json
import struct
import sys
from typing import Any, Dict, Optional

from . import integrity, manager, paths
from .service import service_is_alive


def read_message(stdin=None) -> Optional[Dict[str, Any]]:
    stdin = stdin or sys.stdin.buffer
    raw_len = stdin.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = struct.unpack("<I", raw_len)
    data = stdin.read(length)
    if len(data) < length:
        return None
    return json.loads(data.decode("utf-8"))


def encode_message(message: Dict[str, Any]) -> bytes:
    data = json.dumps(message).encode("utf-8")
    return struct.pack("<I", len(data)) + data


def write_message(message: Dict[str, Any], stdout=None) -> None:
    stdout = stdout or sys.stdout.buffer
    stdout.write(encode_message(message))
    stdout.flush()


def build_status() -> Dict[str, Any]:
    """The full picture the popup shows. ``blocking`` is what the extension acts on; if the
    service looks dead, the extension still blocks (fail-safe) but reports it can't verify."""
    summary = manager.read_summary()
    checks = integrity.check_all()
    alive = service_is_alive() or paths.is_dev_mode()
    return {
        "type": "status",
        "blocking": summary["blocking"],
        "status": summary["status"],
        "requestStatus": summary["request_status"],
        "remainingSeconds": summary["remaining_seconds"],
        "pauseRemainingSeconds": summary["pause_remaining_seconds"],
        "requiredSeconds": summary["required_seconds"],
        "serviceAlive": alive,
        "integrityOk": checks["ok"] and alive,
        "problems": checks["problems"] + ([] if alive else
                    ["The protection service is not running, so the waiting period is not being enforced."]),
        "warnings": checks["warnings"],
    }


def handle(message: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if message and message.get("type") in (None, "getStatus", "ping"):
        return build_status()
    return {"type": "error", "message": "Unknown request"}


def main() -> None:  # pragma: no cover - exercised manually via Firefox
    while True:
        message = read_message()
        if message is None:
            break
        try:
            write_message(handle(message))
        except Exception as exc:
            write_message({"type": "error", "message": str(exc)})


if __name__ == "__main__":
    main()
