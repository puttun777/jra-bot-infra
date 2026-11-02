/** status（旧 ops/tests/test_status.py の全ケース）。 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as S from "../src/state.js";
import { collect, hasProblem, type Row, render } from "../src/status.js";
import { FakeGcp } from "./fakes.js";

function st(mode: S.Mode): S.OpsState {
  const s = S.initialState("2026-11-01T09:00:00Z");
  s.mode = mode;
  s.desired.mode = mode === "NORMAL" ? "NORMAL" : "STOPPED";
  return s;
}
const verdicts = (rows: Row[]): Record<string, string> => Object.fromEntries(rows.map((r) => [r.item, r.verdict]));

describe("status", () => {
  it("uninitialised state is a problem", async () => assert.ok(hasProblem(await collect(undefined, new FakeGcp()))));
  it("consistent STOPPED has no problem", async () => assert.ok(!hasProblem(await collect(st("STOPPED"), new FakeGcp()))));
  it("STOPPED but db running is flagged as unintended billing", async () => {
    const g = new FakeGcp();
    g.sql = { state: "RUNNABLE", activationPolicy: "ALWAYS" };
    assert.equal(verdicts(await collect(st("STOPPED"), g))["Cloud SQL"], "ng");
  });
  it("STOPPED with open ingress, running jobs or enabled scheduler is flagged", async () => {
    const g = new FakeGcp();
    g.svc("jra-bot-dashboard").ingress = "all";
    g.executions = ["e1"];
    g.scheduler["jra-bot-reconcile"] = "ENABLED";
    const v = verdicts(await collect(st("STOPPED"), g));
    assert.equal(v["jra-bot-dashboard ingress"], "ng");
    assert.equal(v["実行中の Job"], "ng");
    assert.equal(v["Scheduler jra-bot-reconcile"], "ng");
  });
  it("NORMAL requires db runnable, iap and open ingress", async () => {
    const g = new FakeGcp();
    for (const s of Object.values(g.services)) s.ingress = "all";
    g.sql = { state: "RUNNABLE", activationPolicy: "ALWAYS" };
    for (const k of Object.keys(g.scheduler)) g.scheduler[k] = "ENABLED";
    assert.ok(!hasProblem(await collect(st("NORMAL"), g)));
    g.svc("jra-bot-dashboard").iapEnabled = false;
    assert.equal(verdicts(await collect(st("NORMAL"), g))["dashboard IAP"], "ng");
  });
  it("iap disabled is flagged in every mode", async () => {
    for (const mode of ["STOPPED", "NORMAL"] as const) {
      const g = new FakeGcp();
      g.svc("jra-bot-dashboard").iapEnabled = false;
      assert.equal(verdicts(await collect(st(mode), g))["dashboard IAP"], "ng", mode);
    }
  });
  it("failed last operation is shown", async () => {
    const s = st("STARTING");
    s.operation = { type: "start", status: "FAILED", current_step: "db-wait", error: "timeout", steps: [] };
    const rows = await collect(s, new FakeGcp());
    assert.equal(verdicts(rows)["最後の操作"], "ng");
    assert.match(render(rows), /\| 項目 \|/);
  });
  it("beacon check result is reported", async () => {
    const rows = await collect(st("STOPPED"), new FakeGcp(), async () => [false, "署名不一致"]);
    assert.equal(verdicts(rows)["ビーコン（署名・seq）"], "ng");
  });
});
