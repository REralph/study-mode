"""Unit tests for the countdown/state machine (pure logic, no Windows needed).

Run from the protection/ directory:  python -m pytest   or   python -m unittest
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from studymode_protection import state as S  # noqa: E402

REQ = S.DEFAULT_REQUIRED_SECONDS  # 9600 s
HB = S.DEFAULT_HEARTBEAT_SECONDS  # 10 s
MAX = S.MAX_TICK_SECONDS          # 30 s


def run(state, seconds, now_start=1000.0, step=HB, max_tick=MAX):
    """Drive heartbeats forward by `seconds` of real time in `step` increments."""
    now = now_start
    # Seed last_tick so the first real step counts.
    state = S.tick(state, now, max_tick)
    end = now + seconds
    while now < end:
        now = min(now + step, end)
        state = S.tick(state, now, max_tick)
    return state, now


class WaitingPeriod(unittest.TestCase):
    def test_default_is_2h40m(self):
        self.assertEqual(REQ, 2 * 3600 + 40 * 60)

    def test_fresh_state_blocks_and_has_no_request(self):
        s = S.new_state()
        self.assertTrue(S.is_blocking(s))
        self.assertIsNone(S.remaining_seconds(s))

    def test_request_then_wait_becomes_ready_and_only_then_allows_removal(self):
        s = S.request_deactivation(S.new_state())
        self.assertEqual(s["request"]["status"], S.WAITING)
        with self.assertRaises(PermissionError):
            S.remove(s)  # too early

        s, now = run(s, REQ - HB)
        self.assertEqual(s["request"]["status"], S.WAITING)
        self.assertGreater(S.remaining_seconds(s), 0)
        self.assertTrue(S.is_blocking(s))  # still blocking during the wait

        s = S.tick(s, now + HB)  # crosses the line
        self.assertEqual(s["request"]["status"], S.READY)
        self.assertEqual(S.remaining_seconds(s), 0.0)

        s = S.remove(s)
        self.assertEqual(s["status"], S.REMOVED)
        self.assertFalse(S.is_blocking(s))

    def test_requesting_twice_does_not_restart_the_clock(self):
        s = S.request_deactivation(S.new_state())
        s, now = run(s, 100)
        ready_at = s["request"]["ready_at_active"]
        s = S.request_deactivation(s)  # ignored
        self.assertEqual(s["request"]["ready_at_active"], ready_at)


class CannotBeBypassed(unittest.TestCase):
    """Requirement 6: closing things or restarting must not shorten or reset the wait."""

    def test_time_while_pc_off_does_not_count(self):
        s = S.request_deactivation(S.new_state())
        s = S.tick(s, 1000.0)
        # PC off for an hour: one big gap, clamped to a single tick.
        s = S.tick(s, 1000.0 + 3600)
        self.assertLessEqual(s["active_seconds"], MAX + 1)
        self.assertGreater(S.remaining_seconds(s), REQ - MAX - 1)

    def test_service_restart_resumes_not_resets(self):
        s = S.request_deactivation(S.new_state())
        s, now = run(s, 5000)
        saved_active = s["active_seconds"]
        # Simulate a restart: reload the same dict, gap since last_tick is clamped.
        s = S.tick(s, now + 120)  # 2-minute downtime
        self.assertGreaterEqual(s["active_seconds"], saved_active)
        self.assertLess(s["active_seconds"], saved_active + MAX + 1)

    def test_clock_moved_backwards_adds_nothing(self):
        s = S.tick(S.new_state(), 1000.0)
        s = S.tick(s, 500.0)  # clock jumped back
        self.assertEqual(s["active_seconds"], 0.0)

    def test_many_small_ticks_sum_correctly(self):
        s = S.request_deactivation(S.new_state())
        s, _ = run(s, REQ, step=1.0)
        self.assertEqual(s["request"]["status"], S.READY)


class ChangingTheWait(unittest.TestCase):
    def test_lengthening_applies_immediately_to_a_pending_request(self):
        s = S.request_deactivation(S.new_state())
        s, _ = run(s, 1000)
        s = S.set_required_seconds(s, REQ * 2)
        self.assertAlmostEqual(S.remaining_seconds(s), REQ * 2 - 1000, delta=HB + 1)

    def test_shortening_cannot_rush_a_wait_already_started(self):
        s = S.request_deactivation(S.new_state())
        s, _ = run(s, 1000)
        before = s["request"]["ready_at_active"]
        s = S.set_required_seconds(s, 60)  # much shorter
        self.assertEqual(s["request"]["ready_at_active"], before)  # unchanged
        # But the shorter period does apply to the *next* request.
        s = S.activate(s)
        s = S.set_required_seconds(s, 60)
        s = S.request_deactivation(s)
        self.assertAlmostEqual(S.remaining_seconds(s), 60, delta=HB + 1)

    def test_rejects_nonpositive(self):
        with self.assertRaises(ValueError):
            S.set_required_seconds(S.new_state(), 0)


class PauseAndActivate(unittest.TestCase):
    def _ready(self):
        s = S.request_deactivation(S.new_state())
        s, now = run(s, REQ)
        return s

    def test_pause_turns_off_then_auto_reactivates(self):
        s = self._ready()
        s = S.pause(s, 600)
        self.assertEqual(s["status"], S.PAUSED)
        self.assertFalse(S.is_blocking(s))
        self.assertIsNone(s["request"])
        s, now = run(s, 599)
        self.assertEqual(s["status"], S.PAUSED)
        s = S.tick(s, now + HB)
        self.assertEqual(s["status"], S.ACTIVE)
        self.assertTrue(S.is_blocking(s))

    def test_pause_rejected_before_ready(self):
        s = S.request_deactivation(S.new_state())
        with self.assertRaises(PermissionError):
            S.pause(s, 600)

    def test_activate_is_immediate_and_clears_everything(self):
        s = self._ready()
        s = S.remove(s)
        self.assertFalse(S.is_blocking(s))
        s = S.activate(s)
        self.assertTrue(S.is_blocking(s))
        self.assertIsNone(s["request"])

    def test_cancel_keeps_protection_on(self):
        s = S.request_deactivation(S.new_state())
        s, _ = run(s, 1000)
        s = S.cancel_request(s)
        self.assertIsNone(s["request"])
        self.assertTrue(S.is_blocking(s))


if __name__ == "__main__":
    unittest.main(verbosity=2)
