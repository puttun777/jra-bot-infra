import unittest

from jrabot_ops import state as S
from jrabot_ops.status import collect, has_problem, render

from .fakes import FakeGcp


def st(mode):
    s = S.initial_state("2026-11-01T09:00:00Z")
    s["mode"] = mode
    s["desired"]["mode"] = "NORMAL" if mode == "NORMAL" else "STOPPED"
    return s


def verdicts(rows):
    return {r.item: r.verdict for r in rows}


class StatusTests(unittest.TestCase):
    def test_uninitialised_state_is_a_problem(self):
        self.assertTrue(has_problem(collect(None, FakeGcp())))

    def test_consistent_stopped_has_no_problem(self):
        self.assertFalse(has_problem(collect(st("STOPPED"), FakeGcp())))

    def test_stopped_but_db_running_is_flagged_as_unintended_billing(self):
        g = FakeGcp()
        g.sql = {"state": "RUNNABLE", "activation_policy": "ALWAYS"}
        self.assertEqual(verdicts(collect(st("STOPPED"), g))["Cloud SQL"], "ng")

    def test_stopped_with_open_ingress_running_jobs_or_enabled_scheduler_is_flagged(self):
        g = FakeGcp()
        g.services["jra-bot-dashboard"]["ingress"] = "all"
        g.executions = ["e1"]
        g.scheduler["jra-bot-reconcile"] = "ENABLED"
        v = verdicts(collect(st("STOPPED"), g))
        self.assertEqual(v["jra-bot-dashboard ingress"], "ng")
        self.assertEqual(v["実行中の Job"], "ng")
        self.assertEqual(v["Scheduler jra-bot-reconcile"], "ng")

    def test_normal_requires_db_runnable_iap_and_open_ingress(self):
        g = FakeGcp()
        for n in g.services:
            g.services[n]["ingress"] = "all"
        g.sql = {"state": "RUNNABLE", "activation_policy": "ALWAYS"}
        g.scheduler = {k: "ENABLED" for k in g.scheduler}
        self.assertFalse(has_problem(collect(st("NORMAL"), g)))
        g.services["jra-bot-dashboard"]["iap_enabled"] = False
        self.assertEqual(verdicts(collect(st("NORMAL"), g))["dashboard IAP"], "ng")

    def test_failed_last_operation_is_shown(self):
        s = st("STARTING")
        s["operation"] = {"type": "start", "status": "FAILED", "current_step": "db-wait", "error": "timeout"}
        rows = collect(s, FakeGcp())
        self.assertEqual(verdicts(rows)["最後の操作"], "ng")
        self.assertIn("| 項目 |", render(rows))

    def test_beacon_check_result_is_reported(self):
        rows = collect(st("STOPPED"), FakeGcp(), beacon_check=lambda s: (False, "署名不一致"))
        self.assertEqual(verdicts(rows)["ビーコン（署名・seq）"], "ng")


if __name__ == "__main__":
    unittest.main()
