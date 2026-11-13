"""Tests for the native-messaging host: framing round-trip and the status payload."""

import importlib
import io
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class NativeHost(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["STUDYMODE_HOME"] = self.tmp.name
        for mod in ("paths", "store", "manager", "service", "integrity", "nativehost"):
            importlib.reload(importlib.import_module(f"studymode_protection.{mod}"))
        self.nh = importlib.import_module("studymode_protection.nativehost")
        self.manager = importlib.import_module("studymode_protection.manager")

    def tearDown(self):
        log = self.manager.get_logger()
        for h in list(log.handlers):
            h.close()
            log.removeHandler(h)
        self.manager._logger = None
        os.environ.pop("STUDYMODE_HOME", None)
        self.tmp.cleanup()

    def test_message_round_trip(self):
        encoded = self.nh.encode_message({"type": "getStatus"})
        got = self.nh.read_message(io.BytesIO(encoded))
        self.assertEqual(got, {"type": "getStatus"})

    def test_truncated_stream_returns_none(self):
        self.assertIsNone(self.nh.read_message(io.BytesIO(b"\x02\x00")))

    def test_status_reports_blocking_when_active(self):
        status = self.nh.handle({"type": "getStatus"})
        self.assertEqual(status["type"], "status")
        self.assertTrue(status["blocking"])
        self.assertEqual(status["status"], "active")
        # In dev mode the service marker is absent, so it reports can't-verify but still blocks.
        self.assertIsInstance(status["problems"], list)

    def test_status_follows_a_removal(self):
        # Drive to READY then remove.
        self.manager.set_required_seconds(5)
        self.manager.request_deactivation()
        now = 1000.0
        self.manager.heartbeat(now=now)
        for _ in range(7):
            now += 1.0
            self.manager.heartbeat(now=now)
        self.manager.remove()
        status = self.nh.handle({"type": "getStatus"})
        self.assertFalse(status["blocking"])
        self.assertEqual(status["status"], "removed")

    def test_unknown_request(self):
        self.assertEqual(self.nh.handle({"type": "nonsense"})["type"], "error")


if __name__ == "__main__":
    unittest.main(verbosity=2)
