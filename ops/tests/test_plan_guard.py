import unittest

from jrabot_ops import plan_guard


def rc(typ, actions, before=None, after=None, addr=None):
    return {"address": addr or f"{typ}.x", "type": typ, "change": {"actions": actions, "before": before, "after": after}}


def plan(*rcs):
    return {"resource_changes": list(rcs)}


class PlanGuardTests(unittest.TestCase):
    def test_noop_and_ordinary_update_pass(self):
        p = plan(rc("google_cloud_run_v2_service", ["no-op"]), rc("google_cloud_run_v2_service", ["update"], {"ingress": "internal", "x": 1}, {"ingress": "internal", "x": 2}))
        self.assertEqual(plan_guard.check(p, "STOPPED"), [])

    def test_activation_policy_change_is_rejected(self):
        b = {"settings": [{"activation_policy": "NEVER"}]}
        a = {"settings": [{"activation_policy": "ALWAYS"}]}
        out = plan_guard.check(plan(rc("google_sql_database_instance", ["update"], b, a)), "NORMAL")
        self.assertTrue(any("activation_policy" in m for m in out), out)

    def test_ingress_and_paused_changes_are_rejected(self):
        out = plan_guard.check(plan(rc("google_cloud_run_v2_service", ["update"], {"ingress": "internal"}, {"ingress": "all"})), "STOPPED")
        self.assertTrue(any("ingress" in m for m in out))
        out = plan_guard.check(plan(rc("google_cloud_scheduler_job", ["update"], {"paused": True}, {"paused": False})), "STOPPED")
        self.assertTrue(any("paused" in m for m in out))

    def test_delete_or_replace_of_protected_resources_is_rejected_unless_allowed(self):
        for t in plan_guard.PROTECTED_DESTROY:
            p = plan(rc(t, ["delete", "create"], {"a": 1}, {"a": 1}))
            self.assertTrue(plan_guard.check(p, "NORMAL"), t)
            self.assertFalse([m for m in plan_guard.check(p, "NORMAL", allow_destroy=True) if "削除" in m], t)

    def test_public_grants_are_rejected_except_the_two_designed_ones(self):
        bad = rc("google_cloud_run_v2_service_iam_member", ["create"], None, {"member": "allUsers", "name": "jra-bot-dashboard"}, "google_cloud_run_v2_service_iam_member.dash")
        self.assertTrue(plan_guard.check(plan(bad), "NORMAL"))
        ok_ingest = rc("google_cloud_run_v2_service_iam_member", ["create"], None, {"member": "allUsers", "name": "jra-bot-ingest"}, "google_cloud_run_v2_service_iam_member.jra-bot-ingest")
        self.assertEqual(plan_guard.check(plan(ok_ingest), "NORMAL"), [])
        auth = rc("google_storage_bucket_iam_member", ["create"], None, {"member": "allAuthenticatedUsers"}, "google_storage_bucket_iam_member.data")
        self.assertTrue(plan_guard.check(plan(auth), "NORMAL"))

    def test_iap_disable_is_rejected(self):
        out = plan_guard.check(plan(rc("google_cloud_run_v2_service", ["update"], {"iap_enabled": True, "ingress": "all"}, {"iap_enabled": False, "ingress": "all"})), "NORMAL")
        self.assertTrue(any("IAP" in m for m in out))

    def test_db_changes_only_in_normal(self):
        p = plan(rc("google_sql_user", ["update"], {"a": 1}, {"a": 2}))
        self.assertTrue(plan_guard.check(p, "STOPPED"))
        self.assertTrue(plan_guard.check(p, "STARTING"))
        self.assertEqual(plan_guard.check(p, "NORMAL"), [])


class PlanGuardReviewFixTests(unittest.TestCase):
    def test_no_apply_while_starting_stopping_or_unknown(self):
        p = plan(rc("google_cloud_run_v2_service", ["update"], {"ingress": "internal", "x": 1}, {"ingress": "internal", "x": 2}))
        for m in ("STARTING", "STOPPING", "UNKNOWN"):
            self.assertTrue(plan_guard.check(p, m), m)
        self.assertEqual(plan_guard.check(plan(rc("google_cloud_run_v2_service", ["no-op"])), "STARTING"), [])

    def test_iam_policy_with_public_member_is_rejected(self):
        pol = '{"bindings":[{"role":"roles/run.invoker","members":["allUsers"]}]}'
        r = rc("google_cloud_run_v2_service_iam_policy", ["create"], None, {"policy_data": pol}, "google_cloud_run_v2_service_iam_policy.dash")
        self.assertTrue(plan_guard.check(plan(r), "NORMAL"))

    def test_iap_accessor_only_users_and_service_accounts(self):
        t = "google_iap_web_cloud_run_service_iam_member"
        self.assertEqual(plan_guard.check(plan(rc(t, ["create"], None, {"member": "user:a@example.com"})), "NORMAL"), [])
        self.assertEqual(plan_guard.check(plan(rc(t, ["create"], None, {"member": "serviceAccount:x@p.iam.gserviceaccount.com"})), "NORMAL"), [])
        for bad in ("domain:example.com", "group:g@example.com", "allUsers"):
            self.assertTrue(plan_guard.check(plan(rc(t, ["create"], None, {"member": bad})), "NORMAL"), bad)

    def test_create_time_ingress_paused_and_invoker_iam(self):
        self.assertTrue(plan_guard.check(plan(rc("google_cloud_run_v2_service", ["create"], None, {"ingress": "INGRESS_TRAFFIC_ALL"})), "NORMAL"))
        self.assertEqual(plan_guard.check(plan(rc("google_cloud_run_v2_service", ["create"], None, {"ingress": "INGRESS_TRAFFIC_INTERNAL_ONLY"})), "NORMAL"), [])
        self.assertTrue(plan_guard.check(plan(rc("google_cloud_scheduler_job", ["create"], None, {"paused": False})), "NORMAL"))
        self.assertTrue(plan_guard.check(plan(rc("google_cloud_run_v2_service", ["update"], {"invoker_iam_disabled": False}, {"invoker_iam_disabled": True})), "NORMAL"))


if __name__ == "__main__":
    unittest.main()
