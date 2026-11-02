/** status（読み取り専用）。期待（mode から導く）と実際（計測）を突き合わせて ✅/❌/⚠️ を出す（OPERATIONS_DESIGN §7）。遷移・修復はしない。旧 status.py の移植。 */
import { SCHEDULER_JOBS, SERVICES } from "./engine.js";
import type { Gcp } from "./ports.js";
import type { OpsState } from "./state.js";

export type Verdict = "ok" | "ng" | "warn";

export interface Row {
  readonly item: string;
  readonly expected: string;
  readonly actual: string;
  readonly verdict: Verdict;
}

const MARK: Record<Verdict, string> = { ok: "✅", ng: "❌", warn: "⚠️" };

export async function collect(
  state: OpsState | undefined,
  gcp: Gcp,
  beaconCheck?: (s: OpsState) => Promise<[boolean, string]>,
): Promise<Row[]> {
  if (state === undefined) return [{ item: "ops-state", expected: "存在する", actual: "無い（未初期化）", verdict: "ng" }];
  const rows: Row[] = [];
  const mode = state.mode;
  const op = state.operation;
  rows.push({ item: "mode", expected: state.desired.mode, actual: mode, verdict: mode === "NORMAL" || mode === "STOPPED" ? "ok" : "warn" });
  if (op?.status === "FAILED") {
    rows.push({
      item: "最後の操作",
      expected: "SUCCEEDED",
      actual: `FAILED（${op.type} / ${String(op.current_step)}）: ${String(op.error)}`,
      verdict: "ng",
    });
  } else if (op !== null && op !== undefined) {
    rows.push({
      item: "最後の操作",
      expected: "SUCCEEDED",
      actual: `${op.status}（${op.type}）`,
      verdict: op.status === "SUCCEEDED" ? "ok" : "warn",
    });
  }
  const expDb = mode === "NORMAL" ? "RUNNABLE" : mode === "STOPPED" ? "STOPPED" : "（遷移中）";
  const expSched = mode === "NORMAL" ? "ENABLED" : mode === "STOPPED" || mode === "STOPPING" ? "PAUSED" : "（遷移中）";
  const db = (await gcp.sqlState()).state ?? "?";
  if (mode === "STOPPED" && db !== "STOPPED")
    rows.push({ item: "Cloud SQL", expected: "STOPPED", actual: `${db}（意図しない起動・課金中）`, verdict: "ng" });
  else if (mode === "NORMAL" && db !== "RUNNABLE") rows.push({ item: "Cloud SQL", expected: "RUNNABLE", actual: db, verdict: "ng" });
  else rows.push({ item: "Cloud SQL", expected: expDb, actual: db, verdict: "ok" });
  for (const name of SERVICES) {
    const st = await gcp.serviceState(name);
    const want = mode === "NORMAL" ? "all" : "internal";
    if (mode === "STARTING" || mode === "STOPPING")
      rows.push({ item: `${name} ingress`, expected: "（遷移中）", actual: st.ingress, verdict: "warn" });
    else rows.push({ item: `${name} ingress`, expected: want, actual: st.ingress, verdict: st.ingress === want ? "ok" : "ng" });
    if (name.endsWith("dashboard")) {
      // IAP の無効化は run.services.update で可能なため、どのモードでも ❌（検知して通知する）
      rows.push({ item: "dashboard IAP", expected: "有効", actual: st.iapEnabled ? "有効" : "無効", verdict: st.iapEnabled ? "ok" : "ng" });
      rows.push({
        item: "dashboard 許可リスト件数",
        expected: "1 件以上",
        actual: String(st.iapMembers),
        verdict: st.iapMembers >= 1 ? "ok" : "warn",
      });
    }
  }
  const running = await gcp.runningExecutions();
  rows.push({
    item: "実行中の Job",
    expected: mode === "STOPPED" ? "0" : "-",
    actual: String(running.length),
    verdict: mode === "STOPPED" && running.length > 0 ? "ng" : "ok",
  });
  const sched = await gcp.schedulerStates();
  for (const j of SCHEDULER_JOBS) {
    const s = sched[j] ?? "?";
    if (mode === "STOPPED" && s !== "PAUSED") rows.push({ item: `Scheduler ${j}`, expected: "PAUSED", actual: s, verdict: "ng" });
    else if (mode === "NORMAL" && s !== "ENABLED") rows.push({ item: `Scheduler ${j}`, expected: "ENABLED", actual: s, verdict: "warn" });
    else rows.push({ item: `Scheduler ${j}`, expected: expSched, actual: s, verdict: "ok" });
  }
  if (beaconCheck !== undefined) {
    const [ok, detail] = await beaconCheck(state);
    rows.push({ item: "ビーコン（署名・seq）", expected: `seq=${state.seq}`, actual: detail, verdict: ok ? "ok" : "ng" });
  }
  return rows;
}

export function render(rows: readonly Row[]): string {
  return [
    "| 項目 | 期待 | 実際 | 判定 |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.item} | ${r.expected} | ${r.actual} | ${MARK[r.verdict]} |`),
  ].join("\n");
}

export function hasProblem(rows: readonly Row[]): boolean {
  return rows.some((r) => r.verdict === "ng");
}
