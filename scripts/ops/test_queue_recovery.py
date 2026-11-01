import contextlib
import importlib.util
import io
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("queue_recovery", Path(__file__).with_name("queue-recovery.py"))
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class NeverStartedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 100_000_000
        self.path = Path(self.temp.name) / "ravi.db"
        self.conn = sqlite3.connect(self.path)
        self.addCleanup(self.conn.close)
        self.conn.executescript("""
          CREATE TABLE sessions (session_key TEXT, system_sent INTEGER, input_tokens INTEGER);
          CREATE TABLE slack_thread_lifecycle (child_session_name TEXT, parent_session_name TEXT,
            child_session_key TEXT, initial_prompt TEXT, prompt_published_at INTEGER, status TEXT, source TEXT);
          CREATE TABLE session_events (session_key TEXT, event_type TEXT, timestamp INTEGER);
          INSERT INTO sessions VALUES ('child-key', 0, 0);
        """)
        self.conn.execute("INSERT INTO slack_thread_lifecycle VALUES (?, ?, ?, ?, ?, ?, ?)",
                          ("child", "parent", "child-key", "original", self.now - 3600_000, "open", "action"))
        self.conn.commit()
        self.patcher = patch.object(recovery, "RAVI_DB", self.path)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def event(self, kind, age):
        self.conn.execute("INSERT INTO session_events VALUES (?, ?, ?)", ("child-key", kind, self.now - age))
        self.conn.commit()

    def test_finds_empty_child_without_timeout_or_parent_history(self):
        self.assertEqual([r["session_name"] for r in recovery.never_started_threads(self.now)], ["child"])

    def test_finds_timed_out_start_even_when_notice_was_delivered(self):
        self.event("prompt.published", 3600_000)
        self.event("dispatch.start_timeout", 3300_000)
        self.event("delivery.delivered", 3299_000)
        self.assertEqual(recovery.never_started_threads(self.now)[0]["prompt_count"], 1)

    def test_excludes_handoff_even_with_zero_token_counters(self):
        self.event("adapter.request", 3500_000)
        self.assertEqual(recovery.never_started_threads(self.now), [])

    def test_excludes_recently_resumed_and_closed_children(self):
        self.event("dispatch.cold_start", 10_000)
        self.assertEqual(recovery.never_started_threads(self.now), [])
        self.conn.execute("DELETE FROM session_events")
        self.conn.execute("UPDATE slack_thread_lifecycle SET status = 'closed'")
        self.conn.commit()
        self.assertEqual(recovery.never_started_threads(self.now), [])

    def test_dry_run_reports_even_without_timeout_events_and_never_replays(self):
        output = io.StringIO()
        with patch.object(recovery.time, "time", return_value=self.now / 1000), \
             patch.object(recovery, "timeout_events", return_value=[]), \
             patch.object(recovery, "load_state", return_value={}), \
             patch.object(recovery, "save_state") as save, \
             patch.object(recovery, "replay") as replay, \
             patch.object(recovery, "log"), \
             patch("sys.argv", ["queue-recovery.py"]), contextlib.redirect_stdout(output):
            self.assertEqual(recovery.main(), 0)
        self.assertIn("ACTION: fila", output.getvalue())
        self.assertIn("child", output.getvalue())
        save.assert_not_called()
        replay.assert_not_called()


    def test_dry_run_stuck_report_does_not_consume_cooldown(self):
        event = {"session_name": "stuck", "source_channel": "slack", "source_account_id": "test",
                 "source_chat_id": "C1", "timestamp": self.now - 3600_000}
        with patch.object(recovery.time, "time", return_value=self.now / 1000), \
             patch.object(recovery, "timeout_events", return_value=[event] * 3), \
             patch.object(recovery, "never_started_threads", return_value=[]), \
             patch.object(recovery, "slack_history", return_value=[]), \
             patch.object(recovery, "answered_after", return_value=False), \
             patch.object(recovery, "load_state", return_value={}), \
             patch.object(recovery, "save_state") as save, \
             patch.object(recovery, "replay") as replay, \
             patch.object(recovery, "log"), \
             patch("sys.argv", ["queue-recovery.py"]), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(recovery.main(), 0)
        save.assert_not_called()
        replay.assert_not_called()


if __name__ == "__main__":
    unittest.main()
