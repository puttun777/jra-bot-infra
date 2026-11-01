"""status（読み取り専用）。期待（mode から導く）と実際（計測）を突き合わせて ✅/❌/⚠️ を出す（OPERATIONS_DESIGN §7）。遷移・修復はしない。"""
from __future__ import annotations

from dataclasses import dataclass

from .engine import SCHEDULER_JOBS, SERVICES
from .ports import Gcp


@dataclass
class Row:
    item: str
    expected: str
    actual: str
    verdict: str  # ok | ng | warn

    def mark(self) -> str:
        return {"ok": "✅", "ng": "❌", "warn": "⚠️"}[self.verdict]


def _expect_for(mode: str) -> dict:
    running = mode in ("NORMAL", "STARTING")
    return {
        "db": "RUNNABLE" if mode == "NORMAL" else ("STOPPED" if mode == "STOPPED" else "（遷移中）"),
        "open": mode == "NORMAL",
        "scheduler": "ENABLED" if mode == "NORMAL" else ("PAUSED" if mode in ("STOPPED", "STOPPING") else "（遷移中）"),
        "running": running,
    }


def collect(state: dict | None, gcp: Gcp, beacon_check=None) -> list[Row]:
    rows: list[Row] = []
    if state is None:
        return [Row("ops-state", "存在する", "無い（未初期化）", "ng")]
    mode = state.get("mode", "?")
    op = state.get("operation") or {}
    rows.append(Row("mode", state.get("desired", {}).get("mode", "?"), mode, "ok" if mode in ("NORMAL", "STOPPED") else "warn"))
    if op.get("status") == "FAILED":
        rows.append(Row("最後の操作", "SUCCEEDED", f"FAILED（{op.get('type')} / {op.get('current_step')}）: {op.get('error')}", "ng"))
    elif op:
        rows.append(Row("最後の操作", "SUCCEEDED", f"{op.get('status')}（{op.get('type')}）", "ok" if op.get("status") == "SUCCEEDED" else "warn"))
    exp = _expect_for(mode)
    sql = gcp.sql_state()
    db_state = sql.get("state", "?")
    if mode == "STOPPED" and db_state != "STOPPED":
        rows.append(Row("Cloud SQL", "STOPPED", f"{db_state}（意図しない起動・課金中）", "ng"))
    elif mode == "NORMAL" and db_state != "RUNNABLE":
        rows.append(Row("Cloud SQL", "RUNNABLE", db_state, "ng"))
    else:
        rows.append(Row("Cloud SQL", exp["db"], db_state, "ok"))
    for name in SERVICES:
        st = gcp.service_state(name)
        ing = st.get("ingress")
        want = "all" if mode == "NORMAL" else "internal"
        if mode in ("STARTING", "STOPPING"):
            rows.append(Row(f"{name} ingress", "（遷移中）", str(ing), "warn"))
        else:
            rows.append(Row(f"{name} ingress", want, str(ing), "ok" if ing == want else "ng"))
        if name.endswith("dashboard"):
            # IAP の無効化は run.services.update で可能なため、どのモードでも ❌（検知して通知する）
            rows.append(Row("dashboard IAP", "有効", "有効" if st.get("iap_enabled") else "無効", "ok" if st.get("iap_enabled") else "ng"))
            members = int(st.get("iap_members", 0))
            rows.append(Row("dashboard 許可リスト件数", "1 件以上", str(members), "ok" if members >= 1 else "warn"))
    running = gcp.running_executions()
    if mode == "STOPPED" and running:
        rows.append(Row("実行中の Job", "0", str(len(running)), "ng"))
    else:
        rows.append(Row("実行中の Job", "-", str(len(running)), "ok"))
    sched = gcp.scheduler_states()
    for j in SCHEDULER_JOBS:
        s = sched.get(j, "?")
        if mode == "STOPPED" and s != "PAUSED":
            rows.append(Row(f"Scheduler {j}", "PAUSED", s, "ng"))
        elif mode == "NORMAL" and s != "ENABLED":
            rows.append(Row(f"Scheduler {j}", "ENABLED", s, "warn"))
        else:
            rows.append(Row(f"Scheduler {j}", exp["scheduler"], s, "ok"))
    if beacon_check is not None:
        ok, detail = beacon_check(state)
        rows.append(Row("ビーコン（署名・seq）", f"seq={state.get('seq')}", detail, "ok" if ok else "ng"))
    return rows


def render(rows: list[Row]) -> str:
    lines = ["| 項目 | 期待 | 実際 | 判定 |", "|---|---|---|---|"]
    lines += [f"| {r.item} | {r.expected} | {r.actual} | {r.mark()} |" for r in rows]
    return "\n".join(lines)


def has_problem(rows: list[Row]) -> bool:
    return any(r.verdict == "ng" for r in rows)
