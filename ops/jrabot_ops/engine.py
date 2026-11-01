"""start / stop のステップ実行（OPERATIONS_DESIGN §5・§6）。

原則: ① 状態（GCS）を**最初に**変えてからリソースを操作する ② 状態の書込みに失敗したらその時点で中断 ③ 各ステップは冪等（実状態を測ってスキップできる）
④ 途中の失敗は STARTING / STOPPING のまま（**失敗を理由に NORMAL へ戻さない**）⑤ 認証設定（IAP・IAM・許可リスト）は変更しない。
"""
from __future__ import annotations

import copy
from dataclasses import dataclass

from . import state as S
from .beacon import make_beacon
from .ports import BeaconStore, Clock, ConflictError, Gcp, StateStore

SERVICES = ("jra-bot-ingest", "jra-bot-dashboard")
SCHEDULER_JOBS = ("jra-bot-calendar-check", "jra-bot-reconcile", "jra-bot-retention")
DB_JOB = "jra-bot-db-migration"
DB_START_TIMEOUT_S = 20 * 60
DB_POLL_S = 15
DRAIN_POLL_S = 20
POST_DRAIN_WAIT_S = 60


class StepFailed(Exception):
    pass


@dataclass
class Inputs:
    actor: str
    reason: str
    run_id: str
    run_url: str = ""
    force: bool = False
    dry_run: bool = False
    apply_pending_migrations: bool = False  # start
    drain_timeout_min: int = 15  # stop
    take_backup: bool = False  # stop


class Ops:
    def __init__(self, store: StateStore, beacon: BeaconStore, gcp: Gcp, clock: Clock, beacon_key, beacon_kid: str, notifier=None) -> None:
        self.store, self.beacon_store, self.gcp, self.clock = store, beacon, gcp, clock
        self.key, self.kid = beacon_key, beacon_kid
        self.notify = notifier or (lambda title, body: None)
        self.state: dict = {}
        self.gen = 0

    # ------------------------------------------------------------------ 状態の読み書き（CAS）
    def _load(self) -> None:
        st, gen = self.store.read()
        if st is None:
            st = S.initial_state(self.clock.now())
            gen = self.store.write(st, 0)
        S.validate(st)
        self.state, self.gen = st, gen

    def _commit(self, new: dict, label: str) -> None:
        """seq を進めて CAS で書く。競合したら再読込して**同じ変更が既に入っているか**を確認できないので、安全側（中断）に倒す。"""
        new = S.bump(new)
        try:
            self.gen = self.store.write(new, self.gen)
        except ConflictError as e:
            raise StepFailed(f"状態の書込みが競合した（他の操作が先に書いた）: {label}") from e
        self.state = new
        self.store.append_history(f"{self.clock.now()}-{new['operation']['type'] if new.get('operation') else 'init'}-{label}", new)

    def _write_beacon(self, mode: str) -> None:
        raw = make_beacon(self.key, self.kid, mode, self.state["seq"], self.clock.now())
        self.beacon_store.write(raw)
        s = copy.deepcopy(self.state)
        s["beacon"] = {"seq": self.state["seq"], "mode": mode, "updated_at": self.clock.now()}
        self._commit(s, f"beacon-{mode}")

    # ------------------------------------------------------------------ ステップ
    def _step(self, name: str, fn) -> None:
        if S.step_done(self.state, name):
            return
        s = S.record_step(self.state, name, "RUNNING", self.clock.now())
        self._commit(s, f"{name}-begin")
        try:
            detail = fn() or ""
        except StepFailed as e:
            self._commit(S.record_step(self.state, name, "FAILED", self.clock.now(), str(e)), f"{name}-failed")
            raise
        except Exception as e:  # noqa: BLE001 - gcloud/GCS の失敗も FAILED として記録し、リースを必ず解放する
            msg = f"{type(e).__name__}: {str(e)[:300]}"
            try:
                self._commit(S.record_step(self.state, name, "FAILED", self.clock.now(), msg), f"{name}-failed")
            except Exception:  # noqa: BLE001 - 記録できなくても元の失敗を伝える
                pass
            raise StepFailed(msg) from e
        self._commit(S.record_step(self.state, name, "DONE", self.clock.now(), detail), f"{name}-done")

    # ------------------------------------------------------------------ 共通の開始・終了
    def _begin(self, op: str, i: Inputs) -> str:
        self._load()
        kind = S.check_transition(self.state, op, i.force)
        if i.force and not i.reason.strip():
            raise S.Rejected("force=true には理由が必要")
        s = S.acquire_lease(self.state, i.run_id, op, self.clock.now(), i.force)
        s = S.with_operation(s, op, i.run_id, i.actor, i.run_url, i.force, self.clock.now(), resume=kind in ("resume", "repair"))
        self._commit(s, f"{op}-lease")
        return kind

    def _end(self, ok: bool, error: str | None) -> None:
        """操作の終了。**計測に失敗してもリースは必ず解放する**（解放できないと次の実行が 90 分拒否される）。"""
        s = S.finish(self.state, ok, self.clock.now(), error)
        s = S.release_lease(s, self.state["lease"]["holder"] if self.state.get("lease") else "")
        try:
            s["last_actual"] = self._measure()
        except Exception as e:  # noqa: BLE001
            s["last_actual"] = {"captured_at": self.clock.now(), "error": f"{type(e).__name__}: {str(e)[:200]}"}
        self._commit(s, "end")

    def _measure(self) -> dict:
        sql = self.gcp.sql_state()
        out = {
            "captured_at": self.clock.now(),
            "db": sql.get("state"),
            "dashboard_ingress": self.gcp.service_state(SERVICES[1]).get("ingress"),
            "ingest_ingress": self.gcp.service_state(SERVICES[0]).get("ingress"),
            "scheduler": self.gcp.scheduler_states(),
            "running_executions": len(self.gcp.running_executions()),
        }
        return out

    # ------------------------------------------------------------------ start
    def start(self, i: Inputs) -> dict:
        kind = self._begin("start", i)
        if i.dry_run:
            self._end(True, None)
            return {"dry_run": True, "kind": kind}
        try:
            repair_only = kind == "repair" and self.state["mode"] == "NORMAL"
            if not repair_only:
                self._step("S1_mode_starting", lambda: self._set_mode("STARTING", "NORMAL", i))
                self._step("S2_beacon_starting", lambda: self._write_beacon("STARTING"))
            self._step("S3_db_up", self._db_up)
            self._step("S4_db_validate", lambda: self._db_validate(i))
            self._step("S6_ingest_open", lambda: self._open("jra-bot-ingest", require_iap=False))
            self._step("S7_dashboard_open", lambda: self._open("jra-bot-dashboard", require_iap=True))
            self._step("S8_health", self._health)
            self._step("S9_scheduler_resume", lambda: [self.gcp.scheduler_resume(j) for j in SCHEDULER_JOBS] and "resumed")
            if not repair_only:
                self._step("S10_mode_normal", lambda: self._set_mode("NORMAL", "NORMAL", i))
                self._step("S11_beacon_normal", lambda: self._write_beacon("NORMAL"))
            else:
                self._repair_beacon("NORMAL")
        except Exception as e:  # noqa: BLE001 - 予期しない失敗でもリースを解放して失敗として伝える
            self._end(False, str(e))
            self.notify("ops-start 失敗", str(e))
            if isinstance(e, (StepFailed, S.Rejected)):
                raise
            raise StepFailed(f"{type(e).__name__}: {str(e)[:300]}") from e
        self._end(True, None)
        return {"mode": self.state["mode"]}

    def _repair_beacon(self, mode: str) -> None:
        """修復モードでも、ビーコンが mode と食い違っていれば署名し直す（S10 成功・S11 失敗後の再実行で更新されない問題）。"""
        b = self.state.get("beacon") or {}
        if b.get("mode") != mode:
            self._step("S_beacon_repair", lambda: self._write_beacon(mode))

    def _set_mode(self, mode: str, desired: str, i: Inputs) -> str:
        s = S.set_mode(self.state, mode, desired, i.actor, i.reason, self.clock.now())
        self._commit(s, f"mode-{mode}")
        return mode

    def _db_up(self) -> str:
        if self.gcp.sql_state().get("state") == "RUNNABLE" and self.gcp.sql_state().get("activation_policy") == "ALWAYS":
            return "already running"
        self.gcp.sql_set_activation("ALWAYS")
        waited = 0
        while waited <= DB_START_TIMEOUT_S:
            if self.gcp.sql_state().get("state") == "RUNNABLE":
                return f"RUNNABLE after {waited}s"
            self.clock.sleep(DB_POLL_S)
            waited += DB_POLL_S
        raise StepFailed("Cloud SQL が RUNNABLE にならなかった（20 分）。再実行で続行できる")

    def _db_validate(self, i: Inputs) -> str:
        code = self.gcp.run_job(DB_JOB, ["--mode=validate"])
        if code == 0:
            return "schema ok"
        if code == 10:
            if not i.apply_pending_migrations:
                raise StepFailed("未適用のマイグレーションがある（終了コード 10）。通常の適用は deploy の責務。apply_pending_migrations=true で再実行すると適用する")
            m = self.gcp.run_job(DB_JOB, ["--mode=migrate"])
            if m != 0:
                raise StepFailed(f"migrate が失敗した（終了コード {m}）")
            return "migrated"
        raise StepFailed(f"スキーマ検証が失敗（終了コード {code}: 1=不整合・失敗版、75=DB 不達）")

    def _open(self, name: str, require_iap: bool) -> str:
        if require_iap:
            st = self.gcp.service_state(name)
            if not st.get("iap_enabled") or int(st.get("iap_members", 0)) < 1:
                raise StepFailed("dashboard の IAP が無効、または許可リストが空。ingress を開けない（認証が緩む経路を作らない）")
        if self.gcp.service_state(name).get("ingress") != "all":
            self.gcp.service_set_ingress(name, "all")
        return "ingress=all"

    def _health(self) -> str:
        bad = []
        for name in SERVICES:
            code = self.gcp.service_health(name, "/internal/ready")
            if code != 200:
                bad.append(f"{name}={code}")
        if bad:
            raise StepFailed("ヘルスチェックに失敗: " + ", ".join(bad))
        return "ready"

    # ------------------------------------------------------------------ stop
    def stop(self, i: Inputs) -> dict:
        kind = self._begin("stop", i)
        if i.dry_run:
            self._end(True, None)
            return {"dry_run": True, "kind": kind}
        try:
            repair_only = kind == "repair" and self.state["mode"] == "STOPPED"
            if not repair_only:
                self._step("S1_mode_stopping", lambda: self._set_mode("STOPPING", "STOPPED", i))
                self._step("S2_beacon_stopping", lambda: self._write_beacon("STOPPING"))
            self._step("S3_scheduler_pause", lambda: [self.gcp.scheduler_pause(j) for j in SCHEDULER_JOBS] and "paused")
            self._step("S5_drain", lambda: self._drain(i))
            self._step("S6_cancel_rest", self._cancel_rest)
            self._step("S7_ingress_internal", self._close)
            self._step("S8_verify_quiet", self._verify_quiet)
            if i.take_backup:
                self._step("S9_backup", lambda: self.gcp.sql_backup() or "backup requested")
            self._step("S10_db_stop", self._db_stop)
            if not repair_only:
                self._step("S11_mode_stopped", lambda: self._set_mode("STOPPED", "STOPPED", i))
                self._step("S12_beacon_stopped", lambda: self._write_beacon("STOPPED"))
            else:
                self._repair_beacon("STOPPED")
        except Exception as e:  # noqa: BLE001
            self._end(False, str(e))
            self.notify("ops-stop 失敗", str(e))
            if isinstance(e, (StepFailed, S.Rejected)):
                raise
            raise StepFailed(f"{type(e).__name__}: {str(e)[:300]}") from e
        self._end(True, None)
        return {"mode": self.state["mode"]}

    def _drain(self, i: Inputs) -> str:
        waited = 0
        limit = i.drain_timeout_min * 60
        while self.gcp.running_executions():
            if waited >= limit:
                return f"timeout after {waited}s; remaining will be cancelled"
            self.clock.sleep(DRAIN_POLL_S)
            waited += DRAIN_POLL_S
        return f"drained after {waited}s"

    def _cancel_rest(self) -> str:
        n = 0
        for ex in self.gcp.running_executions():
            self.gcp.cancel_execution(ex)
            n += 1
        # 取消し後に 0 件でなければ DB を止めない
        for _ in range(6):
            if not self.gcp.running_executions():
                return f"cancelled {n}"
            self.clock.sleep(10)
        raise StepFailed("実行中の Job が残っている。DB を止めない。手動で cancel して stop を再実行")

    def _close(self) -> str:
        for name in SERVICES:
            if self.gcp.service_state(name).get("ingress") != "internal":
                self.gcp.service_set_ingress(name, "internal")  # IAP・IAM には触れない
        return "ingress=internal"

    def _verify_quiet(self) -> str:
        for name in SERVICES:
            if self.gcp.service_state(name).get("ingress") != "internal":
                raise StepFailed(f"{name} の ingress が internal ではない")
        if self.gcp.running_executions():
            raise StepFailed("実行中の Job が残っている")
        for name in SERVICES:
            if self.gcp.service_reachable_externally(name):
                raise StepFailed(f"{name} に外部から到達できる（ingress=internal が効いていない）。DB を止めない")
        self.clock.sleep(POST_DRAIN_WAIT_S)
        if self.gcp.running_executions():
            raise StepFailed("待機中に Job が起動した。DB を止めない")
        return "quiet"

    def _db_stop(self) -> str:
        # 再実行でも毎回、DB を止める直前に実状態を測る（記録だけで前のステップをスキップしない）
        if self.gcp.running_executions():
            raise StepFailed("実行中の Job が残っている。DB を止めない")
        for name in SERVICES:
            if self.gcp.service_state(name).get("ingress") != "internal":
                raise StepFailed(f"{name} の ingress が internal ではない。DB を止めない（stop を最初から再実行）")
        if self.gcp.sql_state().get("state") == "STOPPED":
            return "already stopped"
        self.gcp.sql_set_activation("NEVER")
        waited = 0
        while waited <= DB_START_TIMEOUT_S:
            if self.gcp.sql_state().get("state") == "STOPPED":
                return f"STOPPED after {waited}s"
            self.clock.sleep(DB_POLL_S)
            waited += DB_POLL_S
        raise StepFailed("Cloud SQL が STOPPED にならなかった。stop を再実行")
