import json
import unittest

from jrabot_ops.gcloud_adapter import GcloudAdapter, GcsBeaconStore, GcsStateStore
from jrabot_ops.ports import ConflictError


class Runner:
    def __init__(self, responses=None):
        self.calls: list[list[str]] = []
        self.responses = responses or {}

    def __call__(self, cmd):
        self.calls.append(cmd)
        for key, (code, out) in self.responses.items():
            if key in " ".join(cmd):
                return code, out
        return 0, "null"


def adapter(responses=None, **kw):
    r = Runner(responses)
    return GcloudAdapter("proj", "asia-northeast1", r, **kw), r


class GcloudAdapterTests(unittest.TestCase):
    def test_sql_state_is_parsed(self):
        a, _ = adapter({"sql instances describe": (0, json.dumps({"state": "RUNNABLE", "settings": {"activationPolicy": "ALWAYS", "edition": "ENTERPRISE"}, "databaseVersion": "MYSQL_8_4"}))})
        self.assertEqual(a.sql_state(), {"state": "RUNNABLE", "activation_policy": "ALWAYS", "edition": "ENTERPRISE", "version": "MYSQL_8_4"})

    def test_activation_and_ingress_validate_their_arguments(self):
        a, r = adapter()
        with self.assertRaises(ValueError):
            a.sql_set_activation("ON_DEMAND")
        with self.assertRaises(ValueError):
            a.service_set_ingress("x", "internal-and-cloud-load-balancing")
        a.sql_set_activation("NEVER")
        a.service_set_ingress("jra-bot-dashboard", "internal")
        self.assertIn("--activation-policy=NEVER", r.calls[0])
        self.assertIn("--ingress=internal", r.calls[1])
        self.assertTrue(all("--quiet" in c and "--project=proj" in c for c in r.calls))

    def test_gcloud_failure_raises_without_leaking_the_full_output(self):
        a, _ = adapter({"describe": (1, "x" * 1000 + "ERR")})
        with self.assertRaises(RuntimeError) as cm:
            a.sql_state()
        self.assertLess(len(str(cm.exception)), 300)

    def test_service_state_reads_ingress_ready_and_iap_members(self):
        svc = {"metadata": {"annotations": {"run.googleapis.com/ingress": "internal", "run.googleapis.com/iap-enabled": "true"}}, "status": {"url": "https://d", "conditions": [{"type": "Ready", "status": "True"}]}}
        pol = {"bindings": [{"role": "roles/iap.httpsResourceAccessor", "members": ["user:a@example.com"]}, {"role": "roles/other", "members": ["user:b", "user:c"]}]}
        a, _ = adapter({"run services describe": (0, json.dumps(svc)), "iap web get-iam-policy": (0, json.dumps(pol))})
        st = a.service_state("jra-bot-dashboard")
        self.assertEqual((st["ingress"], st["ready"], st["iap_enabled"], st["iap_members"], st["url"]), ("internal", True, True, 1, "https://d"))

    def test_health_sends_an_id_token_and_external_probe_sends_none(self):
        svc = {"metadata": {"annotations": {}}, "status": {"url": "https://d", "conditions": []}}
        seen = []
        a, _ = adapter({"run services describe": (0, json.dumps(svc))}, http_get=lambda url, tok: seen.append((url, tok)) or 200, id_token=lambda aud: "TOK")
        self.assertEqual(a.service_health("jra-bot-ingest", "/health/ready"), 200)
        self.assertEqual(seen[0], ("https://d/health/ready", "TOK"))
        seen.clear()
        a2, _ = adapter({"run services describe": (0, json.dumps(svc))}, http_get=lambda url, tok: seen.append((url, tok)) or 404)
        self.assertFalse(a2.service_reachable_externally("jra-bot-ingest"))
        self.assertIsNone(seen[0][1])
        a3, _ = adapter({"run services describe": (0, json.dumps(svc))}, http_get=lambda url, tok: 200)
        self.assertTrue(a3.service_reachable_externally("jra-bot-ingest"))

    def test_running_executions_and_run_job_exit_code(self):
        ex = [
            {"metadata": {"name": "e1"}, "status": {"runningCount": 1}},
            {"metadata": {"name": "e2"}, "status": {"runningCount": 0, "completionTime": "2026-11-01T00:00:00Z"}},
            {"metadata": {"name": "e3"}, "status": {"runningCount": 0}},  # 開始待ち（まだ完了していない）も実行中として数える
            {"metadata": {"name": "e4"}, "status": {"conditions": [{"type": "Completed", "status": "False"}]}},
        ]
        a, _ = adapter({"executions list": (0, json.dumps(ex)), "jobs execute": (1, "ERROR: ... exit(10) ...")})
        self.assertEqual(a.running_executions(), ["e1", "e3"])
        self.assertEqual(a.run_job("jra-bot-db-migration", ["--mode=validate"]), 10)
        a2, _ = adapter({"jobs execute": (1, "boom")})
        self.assertEqual(a2.run_job("j", ["--mode=validate"]), 1)
        # 出力に終了コードが無いときは、直近の execution の記述から探す。見つからなければ 1（fail closed）
        a3, r3 = adapter({"jobs execute": (1, "boom"), "executions list": (0, json.dumps([{"status": {"conditions": [{"message": "Container called exit(10)."}]}}]))})
        self.assertEqual(a3.run_job("j", ["--mode=validate"]), 10)

    def test_scheduler_states(self):
        d = [{"name": "projects/p/locations/l/jobs/jra-bot-reconcile", "state": "PAUSED"}]
        a, _ = adapter({"scheduler jobs list": (0, json.dumps(d))})
        self.assertEqual(a.scheduler_states(), {"jra-bot-reconcile": "PAUSED"})


class FakeBlob:
    def __init__(self, bucket, name):
        self.bucket, self.name, self.generation, self.cache_control = bucket, name, 0, None

    def upload_from_string(self, data, content_type=None, if_generation_match=None):
        cur = self.bucket.objects.get(self.name)
        cur_gen = cur[1] if cur else 0
        if if_generation_match is not None and if_generation_match != cur_gen:
            raise Exception("412 Precondition Failed")
        data = data.encode() if isinstance(data, str) else data
        self.generation = cur_gen + 1
        self.bucket.objects[self.name] = (data, self.generation, self.cache_control)

    def download_as_bytes(self):
        return self.bucket.objects[self.name][0]


class FakeBucket:
    def __init__(self):
        self.objects: dict = {}

    def get_blob(self, name):
        if name not in self.objects:
            return None
        b = FakeBlob(self, name)
        b.generation = self.objects[name][1]
        return b

    def blob(self, name):
        return FakeBlob(self, name)


class GcsStoreTests(unittest.TestCase):
    def test_read_write_cas_and_conflict(self):
        bk = FakeBucket()
        s = GcsStateStore(bk)
        self.assertEqual(s.read(), (None, 0))
        g1 = s.write({"seq": 1}, 0)
        self.assertEqual(s.read(), ({"seq": 1}, g1))
        with self.assertRaises(ConflictError):
            s.write({"seq": 2}, 0)
        g2 = s.write({"seq": 2}, g1)
        self.assertGreater(g2, g1)

    def test_history_is_append_only(self):
        s = GcsStateStore(FakeBucket())
        s.append_history("a", {"x": 1})
        with self.assertRaises(Exception):
            s.append_history("a", {"x": 2})

    def test_beacon_is_written_with_no_store(self):
        bk = FakeBucket()
        GcsBeaconStore(bk).write(b"{}")
        self.assertEqual(bk.objects["beacon/mode.json"][2], "no-store")


if __name__ == "__main__":
    unittest.main()
