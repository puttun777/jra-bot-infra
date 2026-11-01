"""ops-state.json の構造と遷移規則（OPERATIONS_DESIGN §1・§2）。純粋な関数だけ（GCP に触れない）。"""
from __future__ import annotations

import copy
import datetime as dt

SCHEMA_VERSION = 1
MODES = ("NORMAL", "STARTING", "STOPPING", "STOPPED")
LEASE_MINUTES = 90

# 操作 → 許可される現在のモード（修復モードを含む）
ALLOWED_FROM = {
    "start": {"STOPPED", "STARTING", "NORMAL"},
    "stop": {"NORMAL", "STARTING", "STOPPING", "STOPPED"},
}


class Rejected(Exception):
    """遷移規則・リース・不正な状態による拒否。状態は変えていない。"""


def _parse(ts: str) -> dt.datetime:
    return dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))


def initial_state(now: str) -> dict:
    """最初の状態（STOPPED。DB 停止・受付停止の初期値と一致させる）。"""
    return {
        "schema_version": SCHEMA_VERSION,
        "seq": 1,
        "mode": "STOPPED",
        "desired": {"mode": "STOPPED", "set_by": "init", "set_at": now, "reason": "初期状態"},
        "operation": None,
        "lease": None,
        "beacon": None,
        "last_actual": None,
        "release": None,
    }


def validate(state: dict) -> None:
    if not isinstance(state, dict) or state.get("schema_version") != SCHEMA_VERSION:
        raise Rejected("ops-state の schema_version が想定外")
    if state.get("mode") not in MODES:
        raise Rejected(f"ops-state の mode が不正: {state.get('mode')!r}")
    if not isinstance(state.get("seq"), int) or state["seq"] < 1:
        raise Rejected("ops-state の seq が不正")


def check_transition(state: dict, op: str, force: bool) -> str:
    """操作を始めてよいか。戻り値は 'normal' | 'resume' | 'repair'。拒否は Rejected。"""
    validate(state)
    mode = state["mode"]
    if mode not in ALLOWED_FROM[op]:
        if force:
            return "repair"
        raise Rejected(f"{op} は mode={mode} から実行できない（STOPPING → start は、停止を完了させてから。強制するなら force=true と理由）")
    if op == "start":
        return {"STOPPED": "normal", "STARTING": "resume", "NORMAL": "repair"}[mode]
    return {"NORMAL": "normal", "STARTING": "normal", "STOPPING": "resume", "STOPPED": "repair"}[mode]


def acquire_lease(state: dict, holder: str, op: str, now: str, force: bool) -> dict:
    """リースを取る。期限内の別の保持者がいれば拒否。期限切れは同じ種類の操作の再実行だけが奪取できる（force なら奪取）。"""
    s = copy.deepcopy(state)
    lease = s.get("lease")
    if lease and lease.get("holder") != holder:
        expired = _parse(lease["expires_at"]) <= _parse(now)
        same_kind = (s.get("operation") or {}).get("type") == op
        if not expired and not force:
            raise Rejected(f"別の操作（{lease['holder']}）がリースを保持している（期限 {lease['expires_at']}）")
        if expired and not same_kind and not force:
            raise Rejected("期限切れのリースは同じ種類の操作の再実行だけが奪取できる（force=true と理由で奪取）")
    expires = (_parse(now) + dt.timedelta(minutes=LEASE_MINUTES)).strftime("%Y-%m-%dT%H:%M:%SZ")
    s["lease"] = {"holder": holder, "expires_at": expires}
    return s


def release_lease(state: dict, holder: str) -> dict:
    s = copy.deepcopy(state)
    if s.get("lease") and s["lease"].get("holder") == holder:
        s["lease"] = None
    return s


def with_operation(state: dict, op: str, op_id: str, actor: str, run_url: str, force: bool, now: str, resume: bool) -> dict:
    s = copy.deepcopy(state)
    prev = s.get("operation") or {}
    # 同じ種類の操作の再実行は完了済みのステップを引き継ぐ（冪等な続き）
    keep_steps = prev.get("steps", []) if resume and prev.get("type") == op and prev.get("status") == "FAILED" else []
    s["operation"] = {
        "id": op_id,
        "type": op,
        "status": "RUNNING",
        "force": force,
        "run_url": run_url,
        "actor": actor,
        "started_at": now,
        "finished_at": None,
        "current_step": None,
        "steps": [dict(x) for x in keep_steps],
        "error": None,
    }
    return s


def step_done(state: dict, name: str) -> bool:
    return any(x["name"] == name and x["status"] == "DONE" for x in (state.get("operation") or {}).get("steps", []))


def record_step(state: dict, name: str, status: str, now: str, detail: str = "") -> dict:
    s = copy.deepcopy(state)
    op = s["operation"]
    op["current_step"] = name
    steps = [x for x in op["steps"] if x["name"] != name]
    steps.append({"name": name, "status": status, "at": now, "detail": detail[:300]})
    op["steps"] = steps
    return s


def set_mode(state: dict, mode: str, desired: str, actor: str, reason: str, now: str) -> dict:
    s = copy.deepcopy(state)
    s["mode"] = mode
    s["desired"] = {"mode": desired, "set_by": actor, "set_at": now, "reason": reason}
    return s


def bump(state: dict) -> dict:
    s = copy.deepcopy(state)
    s["seq"] = state["seq"] + 1
    return s


def finish(state: dict, ok: bool, now: str, error: str | None) -> dict:
    s = copy.deepcopy(state)
    op = s["operation"]
    op["status"] = "SUCCEEDED" if ok else "FAILED"
    op["finished_at"] = now
    op["error"] = None if ok else (error or "")[:500]
    return s
