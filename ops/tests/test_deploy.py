import json
import os
import unittest

from jrabot_ops.deploy import DeployInputs, DeployRejected, check_manifest, deploy

from .fakes import FakeGcp

SCHEMA = json.load(open(os.path.join(os.path.dirname(__file__), "..", "..", "schemas", "release-manifest.v2.json"), encoding="utf-8"))
PRJ = "jra-bot-prod-1"
H = "a" * 64


def manifest(**over):
    m = {
        "schema_version": 2, "release": "2026.11.0", "git_sha": "b" * 40, "built_at": "2026-11-01T00:00:00Z", "contract_version": "0.4.17", "agent_protocol": 1,
        "images": {n: f"asia-northeast1-docker.pkg.dev/{PRJ}/jra-bot/{n}@sha256:{H}" for n in ("dashboard", "ingest", "bot", "db-migration", "ml-train")},
        "flyway": {"latest_version": "5", "baseline": "1"}, "required_schema_version": "5", "rollback": {"min_app_release": "2026.11.0"},
        "model_schema_versions": [1], "feature_schemas": {k: "sha256:" + H for k in ("calibration", "alpha", "market")}, "feature_schema_hash": "sha256:" + H,
        "runtime": {"jdk": "25", "python": "3.13.1"}, "notes": "test",
    }
    m.update(over)
    return m


def gcp(ingress="all"):
    g = FakeGcp()
    for s in g.services.values():
        s["ingress"] = ingress
    return g


class ManifestTests(unittest.TestCase):
    def test_valid_manifest_passes(self):
        self.assertEqual(check_manifest(manifest(), SCHEMA, PRJ), [])

    def test_tag_other_project_preview_and_contract_are_rejected(self):
        m = manifest()
        m["images"]["bot"] = f"asia-northeast1-docker.pkg.dev/{PRJ}/jra-bot/bot:latest"
        self.assertTrue(check_manifest(m, SCHEMA, PRJ))
        self.assertTrue(check_manifest(manifest(), SCHEMA, "other-project-9"))
        self.assertTrue(check_manifest(manifest(kind="preview", deployable=False), SCHEMA, PRJ))
        self.assertTrue(check_manifest(manifest(contract_version="0.5.0"), SCHEMA, PRJ))


class DeployTests(unittest.TestCase):
    def test_normal_deploy_migrates_before_touching_apps_and_keeps_ingress(self):
        g = gcp()
        out = deploy(manifest(), SCHEMA, "NORMAL", g, DeployInputs(PRJ), log=lambda *_: None)
        self.assertEqual(out["release"], "2026.11.0")
        order = [c for c in g.calls if c.startswith(("job:", "svc-image", "job-image"))]
        self.assertEqual(order[0], "job-image:jra-bot-db-migration")
        self.assertEqual(order[1], "job:jra-bot-db-migration:--mode=validate")
        self.assertLess(order.index("job:jra-bot-db-migration:--mode=validate"), order.index("svc-image:jra-bot-ingest"))
        self.assertLess(order.index("svc-image:jra-bot-ingest"), order.index("svc-image:jra-bot-dashboard"))
        self.assertFalse([c for c in g.calls if c.startswith(("ingress", "sql:", "pause", "resume"))])

    def test_pending_migration_is_applied_then_revalidated(self):
        g = gcp()
        seq = iter([10, 0])
        g.run_job = lambda job, args: (g.calls.append(f"job:{job}:{args[0]}") or (next(seq) if args[0] == "--mode=validate" else 0))
        deploy(manifest(), SCHEMA, "NORMAL", g, DeployInputs(PRJ), log=lambda *_: None)
        self.assertIn("job:jra-bot-db-migration:--mode=migrate", g.calls)

    def test_pending_migration_without_permission_stops_before_apps(self):
        g = gcp()
        g.job_exit["--mode=validate"] = 10
        with self.assertRaises(DeployRejected):
            deploy(manifest(), SCHEMA, "NORMAL", g, DeployInputs(PRJ, apply_migrations=False), log=lambda *_: None)
        self.assertFalse([c for c in g.calls if c.startswith("svc-image")])

    def test_failed_validation_restores_the_previous_migration_image(self):
        for code in (1, 75, 10):
            g = gcp()
            g.job_images["jra-bot-db-migration"] = "previous@sha256:" + "c" * 64
            g.job_exit["--mode=validate"] = code
            with self.assertRaises(DeployRejected) as cm:
                deploy(manifest(), SCHEMA, "NORMAL", g, DeployInputs(PRJ, apply_migrations=False), log=lambda *_: None)
            self.assertEqual(g.job_images["jra-bot-db-migration"], "previous@sha256:" + "c" * 64, code)
            self.assertIn("戻した", str(cm.exception))

    def test_schema_mismatch_or_db_unreachable_stops_before_apps(self):
        for code in (1, 75):
            g = gcp()
            g.job_exit["--mode=validate"] = code
            with self.assertRaises(DeployRejected):
                deploy(manifest(), SCHEMA, "NORMAL", g, DeployInputs(PRJ), log=lambda *_: None)
            self.assertFalse([c for c in g.calls if c.startswith(("svc-image", "job-image:jra-bot-bot"))])

    def test_stopped_is_refused_unless_allowed_and_then_never_runs_migration(self):
        with self.assertRaises(DeployRejected):
            deploy(manifest(), SCHEMA, "STOPPED", gcp("internal"), DeployInputs(PRJ), log=lambda *_: None)
        g = gcp("internal")
        deploy(manifest(), SCHEMA, "STOPPED", g, DeployInputs(PRJ, allow_when_stopped=True), log=lambda *_: None)
        self.assertFalse([c for c in g.calls if c.startswith(("job:", "health"))])
        self.assertTrue([c for c in g.calls if c.startswith("svc-image")])

    def test_transition_modes_are_refused(self):
        for m in ("STARTING", "STOPPING", "UNKNOWN"):
            with self.assertRaises(DeployRejected):
                deploy(manifest(), SCHEMA, m, gcp(), DeployInputs(PRJ), log=lambda *_: None)

    def test_failed_health_check_fails(self):
        g = gcp()
        g.health["jra-bot-dashboard"] = 503
        with self.assertRaises(DeployRejected):
            deploy(manifest(), SCHEMA, "NORMAL", g, DeployInputs(PRJ), log=lambda *_: None)

    def test_ingress_change_during_deploy_is_detected(self):
        g = gcp()
        orig = g.service_set_image
        g.service_set_image = lambda n, i: (orig(n, i), g.services[n].__setitem__("ingress", "internal"))[0]
        with self.assertRaises(DeployRejected):
            deploy(manifest(), SCHEMA, "NORMAL", g, DeployInputs(PRJ), log=lambda *_: None)


if __name__ == "__main__":
    unittest.main()
