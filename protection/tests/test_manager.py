"""Integration tests for the file store + manager: persistence, reload, atomic writes.

These exercise the same code paths the service and app use, but against a temporary
STUDYMODE_HOME, so they need no admin rights and never touch ProgramData.
"""

import importlib
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class ManagerPersistence(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["STUDYMODE_HOME"] = self.tmp.name
        # Reimport so the modules pick up the env var fresh each test.
        import studymode_protection.paths as paths
        import studymode_protection.store as store
        import studymode_protection.manager as manager
        importlib.reload(paths)
        importlib.reload(store)
        importlib.reload(manager)
        self.store = store
        self.manager = manager
        self.S = importlib.import_module("studymode_protection.state")

    def tearDown(self):
        # Release the rotating log file so Windows will let the temp dir be deleted.
        log = self.manager.get_logger()
        for handler in list(log.handlers):
            handler.close()
            log.removeHandler(handler)
        self.manager._logger = None
        os.environ.pop("STUDYMODE_HOME", None)
        self.tmp.cleanup()

    def test_state_survives_a_simulated_restart(self):
        self.manager.request_deactivation()
        self.manager.heartbeat(now=1000.0)
        self.manager.heartbeat(now=1000.0 + 5000)  # ~one clamped tick
        before = self.store.load_state()
        # "Restart": drop everything in memory and read from disk again.
        reloaded = self.store.load_state()
        self.assertEqual(reloaded["request"]["status"], self.S.WAITING)
        self.assertEqual(reloaded["active_seconds"], before["active_seconds"])
        self.assertGreater(self.S.remaining_seconds(reloaded), 0)

    def test_corrupt_state_file_falls_back_to_fresh(self):
        self.store.paths.state_file().parent.mkdir(parents=True, exist_ok=True)
        self.store.paths.state_file().write_text("{ this is not json", encoding="utf-8")
        s = self.store.load_state()
        self.assertEqual(s["status"], self.S.ACTIVE)
        self.assertTrue(self.S.is_blocking(s))

    def test_full_deactivation_flow_through_the_manager(self):
        self.manager.set_required_seconds(20)
        self.manager.request_deactivation()
        now = 1000.0
        self.manager.heartbeat(now=now)
        for _ in range(25):
            now += 1.0
            self.manager.heartbeat(now=now)
        summary = self.manager.read_summary()
        self.assertEqual(summary["request_status"], self.S.READY)
        self.manager.remove()
        self.assertFalse(self.manager.read_summary()["blocking"])

    def test_config_persists_required_seconds(self):
        self.manager.set_required_seconds(1234)
        self.assertEqual(self.store.load_config()["required_seconds"], 1234)


if __name__ == "__main__":
    unittest.main(verbosity=2)
