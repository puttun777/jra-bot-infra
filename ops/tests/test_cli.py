import json
import os
import tempfile
import unittest

from jrabot_ops.cli import main


class CliTests(unittest.TestCase):
    def _plan(self, rcs):
        f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump({"resource_changes": rcs}, f)
        f.close()
        self.addCleanup(os.unlink, f.name)
        return f.name

    def test_plan_guard_exit_codes(self):
        bad = self._plan([{"address": "a", "type": "google_cloud_scheduler_job", "change": {"actions": ["update"], "before": {"paused": True}, "after": {"paused": False}}}])
        ok = self._plan([])
        self.assertEqual(main(["plan-guard", "--plan-json", bad, "--mode", "NORMAL"]), 3)
        self.assertEqual(main(["plan-guard", "--plan-json", ok, "--mode", "NORMAL"]), 0)

    def test_arguments_are_required(self):
        with self.assertRaises(SystemExit) as cm:
            main(["start", "--project", "p"])
        self.assertEqual(cm.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
