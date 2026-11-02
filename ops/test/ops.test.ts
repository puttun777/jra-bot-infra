/** start/stop の状態機械（旧 ops/tests/test_ops.py の全ケースを移植）+ 既知の問題 1〜3・5 の回帰試験。 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { canonicalBytes, makeBeacon } from "../src/beacon.js";
import { type Inputs, Ops, StepFailed } from "../src/engine.js";
import { isRecord } from "../src/json.js";
import { Interrupted } from "../src/ports.js";
import * as S from "../src/state.js";
import { FakeBeacon, FakeClock, FakeGcp, FakeStore } from "./fakes.js";

const { privateKey: KEY, publicKey: PUB } = generateKeyPairSync("ed25519");

function make(state?: unknown, gcp: FakeGcp = new FakeGcp(), signal?: AbortSignal) {
  const store = new FakeStore(state);
  const beacon = new FakeBeacon();
  const clock = new FakeClock();
  const ops = new Ops(store, beacon, gcp, clock, KEY, "beacon-test", undefined, signal);
  return { ops, store, beacon, gcp, clock };
}

const inp = (over: Partial<Inputs> = {}): Inputs => ({
  actor: "owner",
  reason: "テスト",
  runId: "run-1",
  runUrl: "https://example/run/1",
  ...over,
});

function runningState(mode: S.Mode = "NORMAL"): S.OpsState {
  const s = S.initialState("2026-11-01T09:00:00Z");
  s.mode = mode;
  s.desired.mode = mode === "NORMAL" || mode === "STARTING" ? "NORMAL" : "STOPPED";
  return s;
}

function st(store: FakeStore): S.OpsState {
  return S.validate(store.state);
}

function stopNormal(): { state: S.OpsState; gcp: FakeGcp } {
  const gcp = new FakeGcp();
  gcp.sql = { state: "RUNNABLE", activationPolicy: "ALWAYS" };
  for (const s of Object.values(gcp.services)) s.ingress = "all";
  for (const k of Object.keys(gcp.scheduler)) gcp.scheduler[k] = "ENABLED";
  return { state: runningState("NORMAL"), gcp };
}

const idx = (calls: string[], c: string): number => {
  const i = calls.indexOf(c);
  assert.ok(i >= 0, `呼出し ${c} が無い: ${calls.join(",")}`);
  return i;
};

describe("start", () => {
  it("start from stopped runs in the designed order", async () => {
    const { ops, store, beacon, gcp } = make();
    await ops.start(inp());
    const s = st(store);
    assert.equal(s.mode, "NORMAL");
    assert.equal(s.operation?.status, "SUCCEEDED");
    assert.equal(s.lease, null);
    const c = gcp.calls;
    const order = [
      idx(c, "sql:ALWAYS"),
      idx(c, "job:jra-bot-db-migration:--mode=validate"),
      idx(c, "ingress:jra-bot-ingest:all"),
      idx(c, "ingress:jra-bot-dashboard:all"),
      idx(c, "health:jra-bot-ingest"),
      idx(c, "resume:jra-bot-calendar-check"),
    ];
    assert.deepEqual(
      order,
      [...order].sort((a, b) => a - b),
    );
    assert.deepEqual(
      beacon.writes.map((b) => b["mode"]),
      ["STARTING", "NORMAL"],
    );
    assert.ok(Number(beacon.writes[0]?.["seq"]) < Number(beacon.writes[1]?.["seq"]));
    assert.equal(s.last_actual?.["db"], "RUNNABLE");
  });
  it("mode is set before any resource is touched", async () => {
    const { ops, store, gcp } = make();
    const seen: string[] = [];
    gcp.hooks.sqlSetActivation = async (p) => {
      seen.push(st(store).mode);
      await gcp.rawSqlSetActivation(p);
    };
    await ops.start(inp());
    assert.deepEqual(seen, ["STARTING"]);
  });
  it("db timeout leaves STARTING and a rerun continues without repeating done steps", async () => {
    const gcp = new FakeGcp();
    gcp.sqlUpAfter = 10_000;
    const { ops, store } = make(undefined, gcp);
    await assert.rejects(ops.start(inp()), StepFailed);
    assert.equal(st(store).mode, "STARTING"); // NORMAL に戻さない
    assert.equal(st(store).operation?.status, "FAILED");
    assert.equal(st(store).lease, null);
    gcp.sqlUpAfter = 0;
    gcp.polls = 0;
    const ops2 = new Ops(store, new FakeBeacon(), gcp, new FakeClock(), KEY, "k");
    await ops2.start(inp({ runId: "run-2" }));
    assert.equal(st(store).mode, "NORMAL");
    assert.equal(gcp.calls.filter((c) => c === "pause:jra-bot-calendar-check").length, 0);
  });
  it("pending migration is refused unless explicitly allowed", async () => {
    const gcp = new FakeGcp();
    gcp.jobExit["--mode=validate"] = 10;
    const { ops, store } = make(undefined, gcp);
    await assert.rejects(ops.start(inp()), StepFailed);
    assert.equal(st(store).mode, "STARTING");
    assert.ok(!gcp.calls.includes("job:jra-bot-db-migration:--mode=migrate"));
    const ops2 = new Ops(store, new FakeBeacon(), gcp, new FakeClock(), KEY, "k");
    await ops2.start(inp({ runId: "run-2", applyPendingMigrations: true }));
    assert.ok(gcp.calls.includes("job:jra-bot-db-migration:--mode=migrate"));
    assert.equal(st(store).mode, "NORMAL");
  });
  it("schema mismatch or db unreachable fails", async () => {
    for (const code of [1, 75]) {
      const gcp = new FakeGcp();
      gcp.jobExit["--mode=validate"] = code;
      const { ops, store } = make(undefined, gcp);
      await assert.rejects(ops.start(inp()), StepFailed);
      assert.equal(st(store).mode, "STARTING");
    }
  });
  it("dashboard is not opened without iap or an allow list", async () => {
    for (const [iap, members] of [
      [false, 1],
      [true, 0],
    ] as const) {
      const gcp = new FakeGcp();
      Object.assign(gcp.svc("jra-bot-dashboard"), { iapEnabled: iap, iapMembers: members });
      const { ops, store } = make(undefined, gcp);
      await assert.rejects(ops.start(inp()), StepFailed);
      assert.equal(gcp.svc("jra-bot-dashboard").ingress, "internal");
      assert.equal(st(store).mode, "STARTING");
    }
  });
  it("failed health check does not resume the scheduler or reach NORMAL", async () => {
    const gcp = new FakeGcp();
    gcp.health["jra-bot-ingest"] = 503;
    const { ops, store, beacon } = make(undefined, gcp);
    await assert.rejects(ops.start(inp()), StepFailed);
    assert.equal(st(store).mode, "STARTING");
    assert.ok(!gcp.calls.some((c) => c.startsWith("resume:")));
    assert.deepEqual(
      beacon.writes.map((b) => b["mode"]),
      ["STARTING"],
    );
  });
  it("start from STOPPING is rejected unless forced with a reason", async () => {
    await assert.rejects(make(runningState("STOPPING")).ops.start(inp()), S.Rejected);
    await assert.rejects(make(runningState("STOPPING")).ops.start(inp({ force: true, reason: " " })), S.Rejected);
  });
  it("start in NORMAL is a repair that does not change the mode or the beacon", async () => {
    const s = runningState("NORMAL");
    s.beacon = { seq: 1, mode: "NORMAL", updated_at: "2026-11-01T09:00:00Z", kid: "beacon-test" };
    const { ops, store, beacon, gcp } = make(s);
    gcp.sql = { state: "RUNNABLE", activationPolicy: "ALWAYS" };
    await ops.start(inp());
    assert.equal(st(store).mode, "NORMAL");
    assert.deepEqual(beacon.writes, []);
  });
  it("start repair resigns a beacon left at STARTING", async () => {
    const s = runningState("NORMAL");
    s.beacon = { seq: 1, mode: "STARTING", updated_at: "2026-11-01T09:00:00Z" }; // S10 成功・S11 失敗の後
    const { ops, beacon, gcp } = make(s);
    gcp.sql = { state: "RUNNABLE", activationPolicy: "ALWAYS" };
    await ops.start(inp());
    assert.deepEqual(
      beacon.writes.map((b) => b["mode"]),
      ["NORMAL"],
    );
  });
  it("dry-run writes nothing at all, not even the lease or the operation record (known issue 1)", async () => {
    // 前回の失敗記録（再実行の続きの情報）がある状態で dry-run しても、記録が上書きされない
    const s = runningState("STOPPING");
    s.operation = {
      id: "run-0",
      type: "stop",
      status: "FAILED",
      steps: [{ name: "S3_scheduler_pause", status: "DONE", at: "2026-11-01T09:00:00Z", detail: "paused" }],
      error: "x",
    };
    const { ops, store, beacon, gcp } = make(s);
    const before = structuredClone(store.state);
    const out = await ops.stop(inp({ dryRun: true }));
    assert.ok("dryRun" in out && out.kind === "resume");
    assert.deepEqual(store.state, before);
    assert.equal(store.writes, 0);
    assert.deepEqual(gcp.calls, []);
    assert.deepEqual(beacon.writes, []);
    const fresh = make();
    await fresh.ops.start(inp({ dryRun: true }));
    assert.equal(fresh.store.state, undefined, "初期化の書込みもしない");
  });
  it("dry-run reports refusals the real run would hit (live lease / forbidden transition)", async () => {
    const s = S.acquireLease(runningState("NORMAL"), "other-run", "stop", "2026-11-01T10:00:00Z", false);
    await assert.rejects(make(s).ops.start(inp({ dryRun: true })), S.Rejected);
    await assert.rejects(make(runningState("STOPPING")).ops.start(inp({ dryRun: true })), S.Rejected);
  });
});

describe("stop", () => {
  it("stop order: state first, then scheduler, drain, ingress and db last", async () => {
    const { state, gcp } = stopNormal();
    gcp.executions = ["exec-1"];
    gcp.drainAfterPolls = 3;
    const { ops, store, beacon } = make(state, gcp);
    await ops.stop(inp());
    assert.equal(st(store).mode, "STOPPED");
    const c = gcp.calls;
    assert.ok(idx(c, "pause:jra-bot-calendar-check") < idx(c, "ingress:jra-bot-ingest:internal"));
    assert.ok(idx(c, "ingress:jra-bot-dashboard:internal") < idx(c, "sql:NEVER"));
    assert.deepEqual(
      beacon.writes.map((b) => b["mode"]),
      ["STOPPING", "STOPPED"],
    );
    assert.equal(gcp.sql.state, "STOPPED");
  });
  it("stop never touches authentication", async () => {
    const { state, gcp } = stopNormal();
    await make(state, gcp).ops.stop(inp());
    assert.equal(gcp.svc("jra-bot-dashboard").iapEnabled, true);
    assert.equal(gcp.svc("jra-bot-dashboard").iapMembers, 1);
    assert.ok(!gcp.calls.some((c) => c.toLowerCase().includes("iam") || c.toLowerCase().includes("iap")));
  });
  it("jobs that cannot be cancelled block the db stop", async () => {
    const { state, gcp } = stopNormal();
    gcp.executions = ["stuck"];
    gcp.cancelWorks = false;
    const { ops, store } = make(state, gcp);
    await assert.rejects(ops.stop(inp({ drainTimeoutMin: 0 })), StepFailed);
    assert.equal(st(store).mode, "STOPPING");
    assert.ok(!gcp.calls.includes("sql:NEVER"));
  });
  it("externally reachable service blocks the db stop", async () => {
    const { state, gcp } = stopNormal();
    gcp.externallyReachable = true;
    const { ops, store } = make(state, gcp);
    await assert.rejects(ops.stop(inp()), StepFailed);
    assert.ok(!gcp.calls.includes("sql:NEVER"));
    assert.equal(st(store).mode, "STOPPING");
  });
  it("rerun after failure resumes and a failure never returns to NORMAL", async () => {
    const { state, gcp } = stopNormal();
    gcp.externallyReachable = true;
    const { ops, store } = make(state, gcp);
    await assert.rejects(ops.stop(inp()), StepFailed);
    gcp.externallyReachable = false;
    await new Ops(store, new FakeBeacon(), gcp, new FakeClock(), KEY, "k").stop(inp({ runId: "run-2" }));
    assert.equal(st(store).mode, "STOPPED");
    assert.equal(gcp.calls.filter((c) => c === "pause:jra-bot-calendar-check").length, 1); // 完了済みのステップは繰り返さない
  });
  it("stop in STOPPED repairs an unexpectedly running db", async () => {
    const gcp = new FakeGcp();
    gcp.sql = { state: "RUNNABLE", activationPolicy: "ALWAYS" };
    const s = runningState("STOPPED");
    s.beacon = { seq: 1, mode: "STOPPED", updated_at: "2026-11-01T09:00:00Z", kid: "beacon-test" };
    const { ops, beacon } = make(s, gcp);
    await ops.stop(inp());
    assert.equal(gcp.sql.state, "STOPPED");
    assert.deepEqual(beacon.writes, []); // ビーコンが mode と一致していれば書き直さない
  });
  it("repair resigns a beacon that does not match the mode", async () => {
    const s = runningState("STOPPED");
    s.beacon = { seq: 1, mode: "STOPPING", updated_at: "2026-11-01T09:00:00Z" }; // S12 が失敗して残った状態
    const { ops, store, beacon } = make(s);
    await ops.stop(inp());
    assert.deepEqual(
      beacon.writes.map((b) => b["mode"]),
      ["STOPPED"],
    );
    assert.equal(st(store).beacon?.mode, "STOPPED");
  });
  it("backup is taken before the db stop when requested", async () => {
    const { state, gcp } = stopNormal();
    await make(state, gcp).ops.stop(inp({ takeBackup: true }));
    assert.ok(idx(gcp.calls, "sql:backup") < idx(gcp.calls, "sql:NEVER"));
  });
});

describe("state and concurrency", () => {
  it("a concurrent operation with a live lease is rejected", async () => {
    const s = S.acquireLease(runningState("NORMAL"), "other-run", "stop", "2026-11-01T10:00:00Z", false);
    await assert.rejects(make(s).ops.start(inp()), S.Rejected);
  });
  it("expired lease can be taken over only by the same kind of operation", async () => {
    const mk = (): S.OpsState => {
      const s = S.acquireLease(runningState("STOPPING"), "old", "stop", "2026-11-01T01:00:00Z", false);
      s.operation = { type: "stop", status: "FAILED", steps: [] };
      return s;
    };
    await make(mk()).ops.stop(inp({ runId: "new" })); // 期限切れ + 同じ種類 → 奪取できる
    await assert.rejects(make(mk()).ops.start(inp({ force: false })), S.Rejected);
  });
  it("cas conflict by another writer aborts before touching resources", async () => {
    const { ops, store, gcp } = make();
    await ops.load();
    store.conflictNext = true;
    const next = S.recordStep(
      S.withOperation(ops.state, "start", "r", "a", "", false, "2026-11-01T10:00:00Z", false),
      "X",
      "DONE",
      "2026-11-01T10:00:00Z",
    );
    await assert.rejects(ops.commit(next, "x"), StepFailed);
    assert.deepEqual(gcp.calls, []);
  });
  it("state write failure stops the operation before resources change", async () => {
    const { ops, store, gcp } = make();
    await store.write(S.initialState("2026-11-01T09:00:00Z"), 0n);
    store.failAfterWrites = store.writes + 2; // リース取得の後に書けなくなる
    await assert.rejects(ops.start(inp()));
    assert.ok(!gcp.calls.includes("sql:ALWAYS"));
  });
  it("lost CAS response: the write landed, a re-read confirms it and the operation continues (known issue 2)", async () => {
    const { ops, store } = make();
    let n = 0;
    const origWrite = store.write.bind(store);
    store.write = async (s, g) => {
      n++;
      if (n === 5) store.loseResponseNext = true; // 途中の 1 回だけ応答を失う
      return origWrite(s, g);
    };
    await ops.start(inp());
    assert.equal(st(store).mode, "NORMAL");
    assert.equal(st(store).operation?.status, "SUCCEEDED");
  });
  it("unknown outcome with an unchanged generation retries the same write", async () => {
    const { ops, store } = make();
    await ops.load();
    const seq = ops.state.seq;
    store.failUnknownNext = true;
    await ops.commit(S.setMode(ops.state, "STOPPED", "STOPPED", "a", "r", "2026-11-01T10:00:00Z"), "retry");
    assert.equal(st(store).seq, seq + 1);
  });
  it("412 is not treated as success: it is success only when the re-read shows our own write (known issue 3)", async () => {
    // (a) 他者の書込みで 412 → 中断（自分の内容ではない）
    const a = make();
    await a.ops.load();
    a.store.interleave = () => {
      a.store.state = { ...S.initialState("2026-11-01T09:00:00Z"), seq: 99 };
      a.store.gen += 1n;
    };
    await assert.rejects(a.ops.commit(S.setMode(a.ops.state, "STOPPED", "STOPPED", "a", "r", "2026-11-01T10:00:00Z"), "x"), StepFailed);
    assert.equal(st(a.store).seq, 99, "他者の状態を上書きしていない");
    // (b) 応答が失われた書込みの再試行で 412 → 再読取りで自分の内容なら成功
    const b = make();
    await b.ops.load();
    const next = S.setMode(b.ops.state, "STOPPED", "STOPPED", "a", "r", "2026-11-01T10:00:00Z");
    const orig = b.store.write.bind(b.store);
    let first = true;
    b.store.write = async (s, g) => {
      if (first) {
        first = false;
        await orig(s, g); // 成立したが…
        throw new (await import("../src/ports.js")).ConflictError("412"); // 呼出側には 412 が返った
      }
      return orig(s, g);
    };
    await b.ops.commit(next, "y");
    assert.equal(b.ops.gen, b.store.gen);
  });
  it("key rotation resigns the beacon even when the mode matches", async () => {
    const s = runningState("NORMAL");
    s.beacon = { seq: 1, mode: "NORMAL", updated_at: "2026-11-01T09:00:00Z", kid: "old-key" };
    const { ops, store, beacon, gcp } = make(s);
    gcp.sql = { state: "RUNNABLE", activationPolicy: "ALWAYS" };
    await ops.start(inp());
    assert.deepEqual(
      beacon.writes.map((b) => [b["mode"], b["kid"]]),
      [["NORMAL", "beacon-test"]],
    );
    assert.equal(st(store).beacon?.kid, "beacon-test");
  });
  it("db stop redoes drain, close and verify itself on rerun", async () => {
    const { state, gcp } = stopNormal();
    const { ops, store } = make(state, gcp);
    gcp.hooks.sqlSetActivation = async () => {
      throw new Error("DB 停止の呼出しが失敗");
    };
    await assert.rejects(ops.stop(inp()), StepFailed);
    delete gcp.hooks.sqlSetActivation;
    gcp.svc("jra-bot-dashboard").ingress = "all";
    gcp.executions = ["late-exec"];
    await new Ops(store, new FakeBeacon(), gcp, new FakeClock(), KEY, "beacon-test").stop(inp({ runId: "run-2" }));
    assert.equal(st(store).mode, "STOPPED");
    assert.equal(gcp.svc("jra-bot-dashboard").ingress, "internal");
    assert.ok(gcp.calls.includes("cancel:late-exec"));
    assert.equal(gcp.sql.state, "STOPPED");
  });
  it("interrupt (SIGTERM) releases the lease and records the failure (known issue 5)", async () => {
    const ac = new AbortController();
    const gcp = new FakeGcp();
    gcp.hooks.sqlSetActivation = async () => {
      ac.abort("SIGTERM");
      throw new Interrupted("SIGTERM");
    };
    const { ops, store } = make(runningState("STOPPED"), gcp, ac.signal);
    await assert.rejects(ops.start(inp()), Interrupted);
    assert.equal(st(store).lease, null);
    assert.equal(st(store).operation?.status, "FAILED");
    assert.equal(st(store).last_actual?.["error"], "中断されたため計測していない", "中断時は計測しない（猶予内に解放を書く）");
  });
  it("interrupt while waiting (sleep) stops promptly and releases the lease", async () => {
    const ac = new AbortController();
    const gcp = new FakeGcp();
    gcp.sqlUpAfter = 10_000;
    const { ops, store, clock } = make(runningState("STOPPED"), gcp, ac.signal);
    const origSleep = clock.sleep.bind(clock);
    clock.sleep = async (s, sig) => {
      if (clock.sleeps.length === 2) ac.abort("SIGINT");
      return origSleep(s, sig);
    };
    await assert.rejects(ops.start(inp()), Interrupted);
    assert.ok(clock.sleeps.length <= 3);
    assert.equal(st(store).lease, null);
    assert.equal(st(store).operation?.status, "FAILED");
  });
  it("a second interrupt during the end does not leave the lease", async () => {
    const ac = new AbortController();
    const gcp = new FakeGcp();
    gcp.hooks.sqlSetActivation = async () => {
      ac.abort("SIGINT");
      throw new Interrupted("SIGINT");
    };
    let n = 0;
    gcp.hooks.sqlState = async () => {
      n++;
      if (n >= 2) throw new Interrupted("SIGTERM");
      return gcp.rawSqlState();
    };
    const { ops, store } = make(runningState("STOPPED"), gcp, ac.signal);
    await assert.rejects(ops.start(inp()), Interrupted);
    assert.equal(st(store).lease, null);
    assert.equal(st(store).operation?.status, "FAILED");
  });
  it("unexpected gcloud failure is recorded as FAILED and releases the lease", async () => {
    const gcp = new FakeGcp();
    gcp.hooks.sqlSetActivation = async () => {
      throw new Error("gcloud 失敗: sql patch");
    };
    const notes: string[] = [];
    const { ops, store } = make(runningState("STOPPED"), gcp);
    ops.notify = (t) => notes.push(t);
    await assert.rejects(ops.start(inp()), StepFailed);
    const s = st(store);
    assert.equal(s.lease, null);
    assert.equal(s.operation?.status, "FAILED");
    assert.equal(s.operation?.steps.filter((x) => x.name === "S3_db_up").at(-1)?.status, "FAILED");
    assert.equal(s.mode, "STARTING");
    assert.ok(notes.length > 0);
    await new Ops(store, new FakeBeacon(), new FakeGcp(), new FakeClock(), KEY, "k").start(inp({ runId: "run-2" }));
    assert.equal(st(store).mode, "NORMAL");
  });
  it("measurement failure at the end still releases the lease", async () => {
    const { state, gcp } = stopNormal();
    const { ops, store } = make(state, gcp);
    gcp.hooks.schedulerStates = async () => {
      throw new Error("測れない");
    };
    await ops.stop(inp());
    assert.equal(st(store).lease, null);
    assert.ok(st(store).last_actual !== null && "error" in (st(store).last_actual ?? {}));
  });
  it("db stop rechecks running jobs even when earlier steps are recorded done", async () => {
    const { state, gcp } = stopNormal();
    const { ops, store } = make(state, gcp);
    gcp.hooks.sqlSetActivation = async () => {
      throw new Error("DB 停止の呼出しが失敗");
    };
    await assert.rejects(ops.stop(inp()), StepFailed);
    delete gcp.hooks.sqlSetActivation;
    gcp.executions = ["late-exec"];
    gcp.cancelWorks = false;
    await assert.rejects(new Ops(store, new FakeBeacon(), gcp, new FakeClock(), KEY, "k").stop(inp({ runId: "run-2" })), StepFailed);
    assert.ok(!gcp.calls.includes("sql:NEVER"));
  });
  it("schema and seq are validated (including seq beyond 2^53, which is refused instead of rounded)", () => {
    for (const bad of [
      { schema_version: 2, mode: "NORMAL", seq: 1, desired: { mode: "NORMAL" } },
      { schema_version: 1, mode: "X", seq: 1, desired: { mode: "NORMAL" } },
      { schema_version: 1, mode: "NORMAL", seq: 0, desired: { mode: "NORMAL" } },
      { schema_version: 1, mode: "NORMAL", seq: 1.5, desired: { mode: "NORMAL" } },
      { schema_version: 1, mode: "NORMAL", seq: JSON.parse("9007199254740993"), desired: { mode: "NORMAL" } },
      { schema_version: 1, mode: "NORMAL", seq: 1 },
      null,
      [],
    ]) {
      assert.throws(() => S.validate(bad), S.Rejected, JSON.stringify(bad));
    }
  });
  it("unknown fields of ops-state are preserved on write", async () => {
    const s = { ...runningState("STOPPED"), future_field: { x: 1 } };
    const { ops, store } = make(s);
    await ops.start(inp());
    assert.ok(isRecord(store.state) && isRecord(store.state["future_field"]));
  });
  it("seq increases on every write", async () => {
    const { ops, store } = make();
    await ops.start(inp());
    assert.ok(st(store).seq > 10);
  });
});

describe("beacon", () => {
  it("signature verifies with the agent canonical form", async () => {
    const { verify } = await import("node:crypto");
    const raw = makeBeacon(KEY, "beacon-test", "STOPPED", 7, "2026-11-01T10:00:00Z");
    const doc = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    assert.ok(!("phase" in doc));
    assert.deepEqual(Object.keys(doc).sort(), ["kid", "mode", "schema_version", "seq", "sig", "updatedAt", "validUntil"]);
    const sig = Buffer.from(String(doc["sig"]), "base64url");
    assert.equal(verify(null, canonicalBytes(doc), PUB, sig), true);
    assert.equal(verify(null, canonicalBytes({ ...doc, mode: "NORMAL" }), PUB, sig), false);
  });
});
