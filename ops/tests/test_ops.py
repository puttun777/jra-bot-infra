import unittest

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from jrabot_ops import state as S
from jrabot_ops.beacon import canonical_bytes, make_beacon
from jrabot_ops.engine import Inputs, Ops, StepFailed

from .fakes import FakeBeacon, FakeClock, FakeGcp, FakeStore

KEY = Ed25519PrivateKey.generate()


def make(state=None, gcp=None):
    store, beacon, gcp, clock = FakeStore(state), FakeBeacon(), gcp or FakeGcp(), FakeClock()
    return Ops(store, beacon, gcp, clock, KEY, "beacon-test"), store, beacon, gcp, clock


def inp(**kw):
    base = dict(actor="owner", reason="テスト", run_id="run-1", run_url="https://example/run/1")
    base.update(kw)
    return Inputs(**base)


def running_state(mode="NORMAL"):
    s = S.initial_state("2026-11-01T09:00:00Z")
    s["mode"] = mode
    s["desired"]["mode"] = "NORMAL" if mode in ("NORMAL", "STARTING") else "STOPPED"
    return s


class StartTests(unittest.TestCase):
    def test_start_from_stopped_runs_in_the_designed_order(self):
        ops, store, beacon, gcp, _ = make()
        ops.start(inp())
        st = store.state
        self.assertEqual(st["mode"], "NORMAL")
        self.assertEqual(st["operation"]["status"], "SUCCEEDED")
        self.assertIsNone(st["lease"])
        # 順序: DB 起動 → 検証 → ingest → dashboard → 健全性 → Scheduler → NORMAL
        c = gcp.calls
        order = [c.index("sql:ALWAYS"), c.index("job:jra-bot-db-migration:--mode=validate"), c.index("ingress:jra-bot-ingest:all"),
                 c.index("ingress:jra-bot-dashboard:all"), c.index("health:jra-bot-ingest"), c.index("resume:jra-bot-calendar-check")]
        self.assertEqual(order, sorted(order))
        # ビーコン: STARTING が最初、NORMAL が最後。seq は単調増加で、ops-state.seq と同期して書かれる
        self.assertEqual([b["mode"] for b in beacon.writes], ["STARTING", "NORMAL"])
        self.assertLess(beacon.writes[0]["seq"], beacon.writes[1]["seq"])
        self.assertEqual(st["last_actual"]["db"], "RUNNABLE")

    def test_mode_is_set_before_any_resource_is_touched(self):
        ops, store, beacon, gcp, _ = make()
        seen = []
        orig = gcp.sql_set_activation

        def spy(policy):
            seen.append(store.state["mode"])
            orig(policy)

        gcp.sql_set_activation = spy
        ops.start(inp())
        self.assertEqual(seen, ["STARTING"])

    def test_db_timeout_leaves_starting_and_a_rerun_continues_without_repeating_done_steps(self):
        gcp = FakeGcp()
        gcp.sql_up_after = 10_000  # 起動しない
        ops, store, beacon, gcp, clock = make(gcp=gcp)
        with self.assertRaises(StepFailed):
            ops.start(inp())
        self.assertEqual(store.state["mode"], "STARTING")  # NORMAL に戻さない
        self.assertEqual(store.state["operation"]["status"], "FAILED")
        self.assertIsNone(store.state["lease"])
        gcp.sql_up_after = 0
        gcp._polls = 0
        ops2 = Ops(store, FakeBeacon(), gcp, FakeClock(), KEY, "k")
        ops2.start(inp(run_id="run-2"))
        self.assertEqual(store.state["mode"], "NORMAL")
        self.assertEqual(gcp.calls.count("pause:jra-bot-calendar-check"), 0)

    def test_pending_migration_is_refused_unless_explicitly_allowed(self):
        gcp = FakeGcp()
        gcp.job_exit["--mode=validate"] = 10
        ops, store, *_ = make(gcp=gcp)
        with self.assertRaises(StepFailed):
            ops.start(inp())
        self.assertEqual(store.state["mode"], "STARTING")
        self.assertNotIn("job:jra-bot-db-migration:--mode=migrate", gcp.calls)
        ops2 = Ops(store, FakeBeacon(), gcp, FakeClock(), KEY, "k")
        ops2.start(inp(run_id="run-2", apply_pending_migrations=True))
        self.assertIn("job:jra-bot-db-migration:--mode=migrate", gcp.calls)
        self.assertEqual(store.state["mode"], "NORMAL")

    def test_schema_mismatch_or_db_unreachable_fails(self):
        for code in (1, 75):
            gcp = FakeGcp()
            gcp.job_exit["--mode=validate"] = code
            ops, store, *_ = make(gcp=gcp)
            with self.assertRaises(StepFailed):
                ops.start(inp())
            self.assertEqual(store.state["mode"], "STARTING")

    def test_dashboard_is_not_opened_without_iap_or_an_allow_list(self):
        for iap, members in ((False, 1), (True, 0)):
            gcp = FakeGcp()
            gcp.services["jra-bot-dashboard"].update(iap_enabled=iap, iap_members=members)
            ops, store, _, gcp, _ = make(gcp=gcp)
            with self.assertRaises(StepFailed):
                ops.start(inp())
            self.assertEqual(gcp.services["jra-bot-dashboard"]["ingress"], "internal")
            self.assertEqual(store.state["mode"], "STARTING")

    def test_failed_health_check_does_not_resume_the_scheduler_or_reach_normal(self):
        gcp = FakeGcp()
        gcp.health["jra-bot-ingest"] = 503
        ops, store, beacon, gcp, _ = make(gcp=gcp)
        with self.assertRaises(StepFailed):
            ops.start(inp())
        self.assertEqual(store.state["mode"], "STARTING")
        self.assertFalse([c for c in gcp.calls if c.startswith("resume:")])
        self.assertEqual([b["mode"] for b in beacon.writes], ["STARTING"])

    def test_start_from_stopping_is_rejected_unless_forced_with_a_reason(self):
        ops, store, *_ = make(state=running_state("STOPPING"))
        with self.assertRaises(S.Rejected):
            ops.start(inp())
        ops2, *_ = make(state=running_state("STOPPING"))
        with self.assertRaises(S.Rejected):
            ops2.start(inp(force=True, reason=" "))

    def test_start_in_normal_is_a_repair_that_does_not_change_the_mode_or_the_beacon(self):
        st = running_state("NORMAL")
        st["beacon"] = {"seq": 1, "mode": "NORMAL", "updated_at": "2026-11-01T09:00:00Z", "kid": "beacon-test"}
        ops, store, beacon, gcp, _ = make(state=st)
        gcp.sql.update(state="RUNNABLE", activation_policy="ALWAYS")
        ops.start(inp())
        self.assertEqual(store.state["mode"], "NORMAL")
        self.assertEqual(beacon.writes, [])

    def test_start_repair_resigns_a_beacon_left_at_starting(self):
        st = running_state("NORMAL")
        st["beacon"] = {"seq": 1, "mode": "STARTING", "updated_at": "2026-11-01T09:00:00Z"}  # S10 成功・S11 失敗の後
        ops, store, beacon, gcp, _ = make(state=st)
        gcp.sql.update(state="RUNNABLE", activation_policy="ALWAYS")
        ops.start(inp())
        self.assertEqual([b["mode"] for b in beacon.writes], ["NORMAL"])

    def test_dry_run_changes_nothing_but_takes_and_releases_the_lease(self):
        ops, store, beacon, gcp, _ = make()
        ops.start(inp(dry_run=True))
        self.assertEqual(gcp.calls, [])
        self.assertEqual(beacon.writes, [])
        self.assertEqual(store.state["mode"], "STOPPED")
        self.assertIsNone(store.state["lease"])


class StopTests(unittest.TestCase):
    def normal(self):
        gcp = FakeGcp()
        gcp.sql.update(state="RUNNABLE", activation_policy="ALWAYS")
        for s in gcp.services.values():
            s["ingress"] = "all"
        gcp.scheduler = {k: "ENABLED" for k in gcp.scheduler}
        return running_state("NORMAL"), gcp

    def test_stop_order_state_first_then_scheduler_drain_ingress_and_db_last(self):
        st, gcp = self.normal()
        gcp.executions = ["exec-1"]
        gcp.drain_after_polls = 3
        ops, store, beacon, gcp, _ = make(state=st, gcp=gcp)
        ops.stop(inp())
        self.assertEqual(store.state["mode"], "STOPPED")
        c = gcp.calls
        self.assertLess(c.index("pause:jra-bot-calendar-check"), c.index("ingress:jra-bot-ingest:internal"))
        self.assertLess(c.index("ingress:jra-bot-dashboard:internal"), c.index("sql:NEVER"))
        self.assertEqual([b["mode"] for b in beacon.writes], ["STOPPING", "STOPPED"])
        self.assertEqual(gcp.sql["state"], "STOPPED")

    def test_stop_never_touches_authentication(self):
        st, gcp = self.normal()
        ops, *_ , gcp, _ = make(state=st, gcp=gcp)
        ops.stop(inp())
        self.assertTrue(gcp.services["jra-bot-dashboard"]["iap_enabled"])
        self.assertEqual(gcp.services["jra-bot-dashboard"]["iap_members"], 1)
        self.assertFalse([c for c in gcp.calls if "iam" in c.lower() or "iap" in c.lower()])

    def test_jobs_that_cannot_be_cancelled_block_the_db_stop(self):
        st, gcp = self.normal()
        gcp.executions = ["stuck"]
        gcp.cancel_works = False
        ops, store, _, gcp, _ = make(state=st, gcp=gcp)
        with self.assertRaises(StepFailed):
            ops.stop(inp(drain_timeout_min=0))
        self.assertEqual(store.state["mode"], "STOPPING")
        self.assertNotIn("sql:NEVER", gcp.calls)

    def test_externally_reachable_service_blocks_the_db_stop(self):
        st, gcp = self.normal()
        gcp.externally_reachable = True
        ops, store, _, gcp, _ = make(state=st, gcp=gcp)
        with self.assertRaises(StepFailed):
            ops.stop(inp())
        self.assertNotIn("sql:NEVER", gcp.calls)
        self.assertEqual(store.state["mode"], "STOPPING")

    def test_rerun_after_failure_resumes_and_a_failure_never_returns_to_normal(self):
        st, gcp = self.normal()
        gcp.externally_reachable = True
        ops, store, _, gcp, _ = make(state=st, gcp=gcp)
        with self.assertRaises(StepFailed):
            ops.stop(inp())
        gcp.externally_reachable = False
        ops2 = Ops(store, FakeBeacon(), gcp, FakeClock(), KEY, "k")
        ops2.stop(inp(run_id="run-2"))
        self.assertEqual(store.state["mode"], "STOPPED")
        self.assertEqual(gcp.calls.count("pause:jra-bot-calendar-check"), 1)  # 完了済みのステップは繰り返さない

    def test_stop_in_stopped_repairs_an_unexpectedly_running_db(self):
        gcp = FakeGcp()
        gcp.sql.update(state="RUNNABLE", activation_policy="ALWAYS")
        st = running_state("STOPPED")
        st["beacon"] = {"seq": 1, "mode": "STOPPED", "updated_at": "2026-11-01T09:00:00Z", "kid": "beacon-test"}
        ops, store, beacon, gcp, _ = make(state=st, gcp=gcp)
        ops.stop(inp())
        self.assertEqual(gcp.sql["state"], "STOPPED")
        self.assertEqual(beacon.writes, [])  # ビーコンが mode と一致していれば書き直さない

    def test_repair_resigns_a_beacon_that_does_not_match_the_mode(self):
        gcp = FakeGcp()
        st = running_state("STOPPED")
        st["beacon"] = {"seq": 1, "mode": "STOPPING", "updated_at": "2026-11-01T09:00:00Z"}  # S12 が失敗して残った状態
        ops, store, beacon, gcp, _ = make(state=st, gcp=gcp)
        ops.stop(inp())
        self.assertEqual([b["mode"] for b in beacon.writes], ["STOPPED"])
        self.assertEqual(store.state["beacon"]["mode"], "STOPPED")

    def test_backup_is_taken_before_the_db_stop_when_requested(self):
        st, gcp = self.normal()
        ops, _, _, gcp, _ = make(state=st, gcp=gcp)
        ops.stop(inp(take_backup=True))
        self.assertLess(gcp.calls.index("sql:backup"), gcp.calls.index("sql:NEVER"))


class StateAndConcurrencyTests(unittest.TestCase):
    def test_a_concurrent_operation_with_a_live_lease_is_rejected(self):
        st = running_state("NORMAL")
        st = S.acquire_lease(st, "other-run", "stop", "2026-11-01T10:00:00Z", False)
        ops, *_ = make(state=st)
        with self.assertRaises(S.Rejected):
            ops.start(inp())

    def test_expired_lease_can_be_taken_over_only_by_the_same_kind_of_operation(self):
        st = running_state("STOPPING")
        st = S.acquire_lease(st, "old", "stop", "2026-11-01T01:00:00Z", False)
        st["operation"] = {"type": "stop", "status": "FAILED", "steps": []}
        ops, *_ = make(state=st)
        ops.stop(inp(run_id="new"))  # 期限切れ + 同じ種類 → 奪取できる

        st2 = running_state("STOPPING")
        st2 = S.acquire_lease(st2, "old", "stop", "2026-11-01T01:00:00Z", False)
        st2["operation"] = {"type": "stop", "status": "FAILED", "steps": []}
        ops2, *_ = make(state=st2)
        with self.assertRaises(S.Rejected):
            ops2.start(inp(force=False))

    def test_cas_conflict_aborts_before_touching_resources(self):
        ops, store, _, gcp, _ = make()
        ops._load()
        store.conflict_next = True
        with self.assertRaises(StepFailed):
            ops._commit(S.record_step(S.with_operation(ops.state, "start", "r", "a", "", False, "2026-11-01T10:00:00Z", False), "X", "DONE", "2026-11-01T10:00:00Z"), "x")
        self.assertEqual(gcp.calls, [])

    def test_state_write_failure_stops_the_operation_before_resources_change(self):
        ops, store, _, gcp, _ = make()
        store.write(S.initial_state("2026-11-01T09:00:00Z"), 0)
        store.fail_after_writes = store.writes + 2  # リース取得の後に書けなくなる
        with self.assertRaises(Exception):
            ops.start(inp())
        self.assertNotIn("sql:ALWAYS", gcp.calls)

    def test_key_rotation_resigns_the_beacon_even_when_the_mode_matches(self):
        st = running_state("NORMAL")
        st["beacon"] = {"seq": 1, "mode": "NORMAL", "updated_at": "2026-11-01T09:00:00Z", "kid": "old-key"}  # 旧鍵で署名された
        ops, store, beacon, gcp, _ = make(state=st)  # 新しい kid = beacon-test
        gcp.sql.update(state="RUNNABLE", activation_policy="ALWAYS")
        ops.start(inp())
        self.assertEqual([(b["mode"], b["kid"]) for b in beacon.writes], [("NORMAL", "beacon-test")])
        self.assertEqual(store.state["beacon"]["kid"], "beacon-test")

    def test_db_stop_redoes_drain_close_and_verify_itself_on_rerun(self):
        st, gcp = StopTests.normal(self)
        ops, store, _, gcp, _ = make(state=st, gcp=gcp)
        orig = gcp.sql_set_activation

        def fail(policy):
            raise RuntimeError("DB 停止の呼出しが失敗")

        gcp.sql_set_activation = fail
        with self.assertRaises(StepFailed):
            ops.stop(inp())
        gcp.sql_set_activation = orig
        # 失敗の後に ingress が開かれ、Job が起動した（S5〜S8 は記録上 DONE のまま）
        gcp.services["jra-bot-dashboard"]["ingress"] = "all"
        gcp.executions = ["late-exec"]
        ops2 = Ops(store, FakeBeacon(), gcp, FakeClock(), KEY, "beacon-test")
        ops2.stop(inp(run_id="run-2"))  # 再実行だけで回復できる（手段が無い状態にならない）
        self.assertEqual(store.state["mode"], "STOPPED")
        self.assertEqual(gcp.services["jra-bot-dashboard"]["ingress"], "internal")
        self.assertIn("cancel:late-exec", gcp.calls)
        self.assertEqual(gcp.sql["state"], "STOPPED")

    def test_interrupt_releases_the_lease_and_records_the_failure(self):
        gcp = FakeGcp()
        gcp.sql_set_activation = lambda policy: (_ for _ in ()).throw(KeyboardInterrupt("SIGTERM"))
        ops, store, _, gcp, _ = make(state=running_state("STOPPED"), gcp=gcp)
        with self.assertRaises(KeyboardInterrupt):
            ops.start(inp())
        self.assertIsNone(store.state["lease"])
        self.assertEqual(store.state["operation"]["status"], "FAILED")

    def test_unexpected_gcloud_failure_is_recorded_as_failed_and_releases_the_lease(self):
        gcp = FakeGcp()
        gcp.sql_set_activation = lambda policy: (_ for _ in ()).throw(RuntimeError("gcloud 失敗: sql patch"))
        notes = []
        ops, store, _, gcp, _ = make(state=running_state("STOPPED"), gcp=gcp)
        ops.notify = lambda t, b: notes.append(t)
        with self.assertRaises(StepFailed):
            ops.start(inp())
        st = store.state
        self.assertIsNone(st["lease"])  # リースが 90 分残らない
        self.assertEqual(st["operation"]["status"], "FAILED")
        self.assertEqual([x["status"] for x in st["operation"]["steps"] if x["name"] == "S3_db_up"][-1], "FAILED")
        self.assertEqual(st["mode"], "STARTING")  # NORMAL に戻さない
        self.assertTrue(notes)
        ops2 = Ops(store, FakeBeacon(), FakeGcp(), FakeClock(), KEY, "k")
        ops2.start(inp(run_id="run-2"))  # 別 run_id の再実行が拒否されない
        self.assertEqual(store.state["mode"], "NORMAL")

    def test_measurement_failure_at_the_end_still_releases_the_lease(self):
        st, gcp = StopTests.normal(self)
        ops, store, _, gcp, _ = make(state=st, gcp=gcp)
        orig = gcp.scheduler_states
        calls = {"n": 0}

        def flaky():
            calls["n"] += 1
            if calls["n"] > 0:
                raise RuntimeError("測れない")
            return orig()

        gcp.scheduler_states = flaky
        ops.stop(inp())
        self.assertIsNone(store.state["lease"])
        self.assertIn("error", store.state["last_actual"])

    def test_db_stop_rechecks_running_jobs_even_when_earlier_steps_are_recorded_done(self):
        st, gcp = StopTests.normal(self)
        ops, store, _, gcp, _ = make(state=st, gcp=gcp)
        orig = gcp.sql_set_activation

        def fail(policy):
            raise RuntimeError("DB 停止の呼出しが失敗")

        gcp.sql_set_activation = fail
        with self.assertRaises(StepFailed):
            ops.stop(inp())
        gcp.sql_set_activation = orig
        gcp.executions = ["late-exec"]  # 失敗の後に新しい Job が起動した
        gcp.cancel_works = False
        ops2 = Ops(store, FakeBeacon(), gcp, FakeClock(), KEY, "k")
        with self.assertRaises(StepFailed):
            ops2.stop(inp(run_id="run-2"))
        self.assertNotIn("sql:NEVER", gcp.calls)

    def test_schema_and_seq_are_validated(self):
        for bad in ({"schema_version": 2, "mode": "NORMAL", "seq": 1}, {"schema_version": 1, "mode": "X", "seq": 1}, {"schema_version": 1, "mode": "NORMAL", "seq": 0}):
            with self.assertRaises(S.Rejected):
                S.validate(bad)

    def test_seq_increases_on_every_write(self):
        ops, store, *_ = make()
        ops.start(inp())
        self.assertGreater(store.state["seq"], 10)


class BeaconTests(unittest.TestCase):
    def test_signature_verifies_with_the_agent_canonical_form(self):
        raw = make_beacon(KEY, "beacon-test", "STOPPED", 7, "2026-11-01T10:00:00Z")
        import base64
        import json

        doc = json.loads(raw)
        self.assertNotIn("phase", doc)
        self.assertEqual(set(doc), {"schema_version", "mode", "seq", "updatedAt", "validUntil", "kid", "sig"})
        sig = base64.urlsafe_b64decode(doc["sig"] + "=" * (-len(doc["sig"]) % 4))
        KEY.public_key().verify(sig, canonical_bytes(doc))
        tampered = dict(doc, mode="NORMAL")
        with self.assertRaises(Exception):
            KEY.public_key().verify(sig, canonical_bytes(tampered))


if __name__ == "__main__":
    unittest.main()
