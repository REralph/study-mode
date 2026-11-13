"""The 'Study Mode Protection' Windows service.

Its only job is to advance the countdown while the PC is on, by calling
``manager.heartbeat()`` on a timer, and to write a heartbeat marker so the UI can tell the
service is alive. It owns no secrets and makes no decisions the pure logic does not; the
protection comes from the ACL on the state file and the Firefox policy, not from this
process (requirement 8). The service is registered under its real name and shows up in
services.msc and Task Manager (requirement 10 - nothing hidden).

Install/remove is done by install/install.ps1 (which calls this with pywin32). Manually:
    python -m studymode_protection.service install|start|stop|remove
"""

from __future__ import annotations

import sys
import time

from . import manager, paths

try:
    import servicemanager
    import win32event
    import win32service
    import win32serviceutil
    _HAVE_PYWIN32 = True
except ImportError:  # pragma: no cover
    _HAVE_PYWIN32 = False
    win32serviceutil = object  # type: ignore


HEARTBEAT_SECONDS = 10


if _HAVE_PYWIN32:
    class ProtectionService(win32serviceutil.ServiceFramework):
        _svc_name_ = paths.SERVICE_NAME
        _svc_display_name_ = paths.SERVICE_DISPLAY_NAME
        _svc_description_ = (
            "Maintains the Study Mode waiting period so protection cannot be turned off "
            "impulsively. Part of Study Mode; safe to see here. Uninstall via Study Mode's uninstaller.")

        def __init__(self, args):
            super().__init__(args)
            self._stop = win32event.CreateEvent(None, 0, 0, None)

        def SvcStop(self):
            self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
            win32event.SetEvent(self._stop)

        def SvcDoRun(self):
            servicemanager.LogMsg(
                servicemanager.EVENTLOG_INFORMATION_TYPE,
                servicemanager.PYS_SERVICE_STARTED,
                (self._svc_name_, ""))
            manager.get_logger().info("Service started")
            self._run()
            manager.get_logger().info("Service stopping")

        def _run(self):
            while True:
                try:
                    manager.heartbeat()
                    _write_alive()
                except Exception as exc:  # never let one bad tick kill the service
                    manager.get_logger().exception("Heartbeat failed: %s", exc)
                if win32event.WaitForSingleObject(self._stop, HEARTBEAT_SECONDS * 1000) == win32event.WAIT_OBJECT_0:
                    break


def _write_alive() -> None:
    """A timestamp the UI reads to show whether the service is actually running."""
    try:
        (paths.home() / "service.alive").write_text(str(time.time()), encoding="utf-8")
    except OSError:
        pass


def service_is_alive(max_age_seconds: float = HEARTBEAT_SECONDS * 4) -> bool:
    """True if the service wrote its heartbeat marker recently."""
    try:
        ts = float((paths.home() / "service.alive").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return (time.time() - ts) <= max_age_seconds


def main() -> None:
    if not _HAVE_PYWIN32:
        sys.exit("pywin32 is required to run the service. Install it with: pip install pywin32")
    win32serviceutil.HandleCommandLine(ProtectionService)


if __name__ == "__main__":
    main()
