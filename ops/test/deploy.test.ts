/** deploy（旧 ops/tests/test_deploy.py の全ケース）+ リース・ロールバック判定（既知の問題 4）・release の記録。 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkManifest, compareVersions, DeployRejected, deploy, judge } from "../src/deploy.js";
import { Ops } from "../src/engine.js";
import * as S from "../src/state.js";
import { FakeBeacon, FakeClock, FakeGcp, FakeStore } from "./fakes.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SCHEMA: unknown = JSON.parse(readFileSync(join(ROOT, "schemas", "release-manifest.v2.json"), "utf8"));
const PRJ = "jra-bot-prod-1";
const H = "a".repeat(64);
const { privateKey: KEY } = generateKeyPairSync("ed25519");
const NAMES = ["dashboard", "ingest", "bot", "db-migration", "ml-train"] as const;

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 2,
    release: "2026.11.0",
    git_sha: "b".repeat(40),
    built_at: "2026-11-01T00:00:00Z",
    contract_version: "0.4.17",
    agent_protocol: 1,
    images: Object.fromEntries(NAMES.map((n) => [n, `asia-northeast1-docker.pkg.dev/${PRJ}/jra-bot/${n}@sha256:${H}`])),
    flyway: { latest_version: "5", baseline: "1" },
    required_schema_version: "5",
    rollback: { min_app_release: "2026.11.0" },
    model_schema_versions: [1],
    feature_schemas: { calibration: `sha256:${H}`, alpha: `sha256:${H}`, market: `sha256:${H}` },
    feature_schema_hash: `sha256:${H}`,
    runtime: { jdk: "25", python: "3.13.1" },
    notes: "test",
    ...over,
  };
}

function stateIn(mode: S.Mode, release?: S.ReleaseInfo): S.OpsState {
  const s = S.initialState("2026-11-01T09:00:00Z");
  s.mode = mode;
  s.desired.mode = mode === "NORMAL" ? "NORMAL" : "STOPPED";
  if (release !== undefined) s.release = release;
  return s;
}

function gcp(ingress = "all"): FakeGcp {
  const g = new FakeGcp();
  for (const s of Object.values(g.services)) s.ingress = ingress;
  return g;
}

const DI = { project: PRJ, allowWhenStopped: false, applyMigrations: true, actor: "owner", runId: "deploy-1", runUrl: "", reason: "" };

async function run(m: unknown, mode: S.Mode, g: FakeGcp, over: Partial<typeof DI> = {}, release?: S.ReleaseInfo) {
  const store = new FakeStore(stateIn(mode, release));
  const ops = new Ops(store, new FakeBeacon(), g, new FakeClock(), KEY, "k");
  const out = await deploy(ops, m, SCHEMA, { ...DI, ...over });
  return { out, store };
}

async function rejected(
  m: unknown,
  mode: S.Mode,
  g: FakeGcp,
  over: Partial<typeof DI> = {},
  release?: S.ReleaseInfo,
): Promise<{ err: DeployRejected; store: FakeStore }> {
  const store = new FakeStore(stateIn(mode, release));
  const ops = new Ops(store, new FakeBeacon(), g, new FakeClock(), KEY, "k");
  try {
    await deploy(ops, m, SCHEMA, { ...DI, ...over });
  } catch (e) {
    assert.ok(e instanceof DeployRejected, String(e));
    return { err: e, store };
  }
  assert.fail("拒否されなかった");
}

const REL = (app: string, schemaMin: string, flyway: string): S.ReleaseInfo => ({
  app_release: app,
  git_sha: "c".repeat(40),
  schema_min_app_release: schemaMin,
  schema_flyway_version: flyway,
  deployed_at: "2026-11-01T00:00:00Z",
  run_id: "old",
});

describe("manifest", () => {
  it("valid manifest passes", () => assert.deepEqual(checkManifest(manifest(), SCHEMA, PRJ).problems, []));
  it("tag, other project, preview and contract are rejected", () => {
    const images = Object.fromEntries(NAMES.map((n) => [n, `asia-northeast1-docker.pkg.dev/${PRJ}/jra-bot/${n}@sha256:${H}`]));
    images["bot"] = `asia-northeast1-docker.pkg.dev/${PRJ}/jra-bot/bot:latest`;
    assert.ok(checkManifest(manifest({ images }), SCHEMA, PRJ).problems.length > 0);
    assert.ok(checkManifest(manifest(), SCHEMA, "other-project-9").problems.length > 0);
    assert.ok(checkManifest(manifest({ kind: "preview", deployable: false }), SCHEMA, PRJ).problems.length > 0);
    assert.ok(checkManifest(manifest({ contract_version: "0.5.0" }), SCHEMA, PRJ).problems.length > 0);
  });
  it("min_app_release newer than release is rejected by the contract check (known issue 4)", () => {
    const p = checkManifest(manifest({ rollback: { min_app_release: "2026.12.0" } }), SCHEMA, PRJ).problems;
    assert.ok(
      p.some((x) => x.includes("min_app_release")),
      p.join("\n"),
    );
  });
});

describe("deploy", () => {
  it("normal deploy migrates before touching apps and keeps ingress", async () => {
    const g = gcp();
    const { out, store } = await run(manifest(), "NORMAL", g);
    assert.equal(out.release, "2026.11.0");
    const order = g.calls.filter((c) => c.startsWith("job:") || c.startsWith("svc-image") || c.startsWith("job-image"));
    assert.equal(order[0], "job-image:jra-bot-db-migration");
    assert.equal(order[1], "job:jra-bot-db-migration:--mode=validate");
    assert.ok(order.indexOf("job:jra-bot-db-migration:--mode=validate") < order.indexOf("svc-image:jra-bot-ingest"));
    assert.ok(order.indexOf("svc-image:jra-bot-ingest") < order.indexOf("svc-image:jra-bot-dashboard"));
    assert.ok(!g.calls.some((c) => c.startsWith("ingress") || c.startsWith("sql:") || c.startsWith("pause") || c.startsWith("resume")));
    const s = S.validate(store.state);
    assert.equal(s.release?.app_release, "2026.11.0");
    assert.equal(s.release?.schema_flyway_version, "5");
    assert.equal(s.lease, null, "リースを解放する");
    assert.equal(s.operation?.type, "deploy");
    assert.equal(s.operation?.status, "SUCCEEDED");
    assert.equal(s.mode, "NORMAL", "deploy は mode を変えない");
  });
  it("pending migration is applied then revalidated", async () => {
    const g = gcp();
    const seq = [10, 0];
    g.hooks.runJob = async (job, args) => {
      g.calls.push(`job:${job}:${args[0] ?? ""}`);
      return args[0] === "--mode=validate" ? (seq.shift() ?? 0) : 0;
    };
    await run(manifest(), "NORMAL", g);
    assert.ok(g.calls.includes("job:jra-bot-db-migration:--mode=migrate"));
  });
  it("pending migration without permission stops before apps", async () => {
    const g = gcp();
    g.jobExit["--mode=validate"] = 10;
    await rejected(manifest(), "NORMAL", g, { applyMigrations: false });
    assert.ok(!g.calls.some((c) => c.startsWith("svc-image")));
  });
  it("failed validation restores the previous migration image", async () => {
    for (const code of [1, 75, 10]) {
      const g = gcp();
      g.jobImages["jra-bot-db-migration"] = `previous@sha256:${"c".repeat(64)}`;
      g.jobExit["--mode=validate"] = code;
      const { err, store } = await rejected(manifest(), "NORMAL", g, { applyMigrations: false });
      assert.equal(g.jobImages["jra-bot-db-migration"], `previous@sha256:${"c".repeat(64)}`, String(code));
      assert.match(err.message, /戻した/);
      const s = S.validate(store.state);
      assert.equal(s.lease, null);
      assert.equal(s.operation?.status, "FAILED");
      assert.equal(s.release, null, "失敗した deploy は release を記録しない");
    }
  });
  it("schema mismatch or db unreachable stops before apps", async () => {
    for (const code of [1, 75]) {
      const g = gcp();
      g.jobExit["--mode=validate"] = code;
      await rejected(manifest(), "NORMAL", g);
      assert.ok(!g.calls.some((c) => c.startsWith("svc-image") || c.startsWith("job-image:jra-bot-bot")));
    }
  });
  it("STOPPED is refused unless allowed, and then never runs migration", async () => {
    await rejected(manifest(), "STOPPED", gcp("internal"));
    const g = gcp("internal");
    await run(manifest(), "STOPPED", g, { allowWhenStopped: true });
    assert.ok(!g.calls.some((c) => c.startsWith("job:") || c.startsWith("health")));
    assert.ok(g.calls.some((c) => c.startsWith("svc-image")));
  });
  it("transition modes are refused (and STARTING/STOPPING keep their operation record)", async () => {
    for (const m of ["STARTING", "STOPPING"] as const) {
      const { store } = await rejected(manifest(), m, gcp());
      assert.equal(store.writes, 0, "拒否は何も書かない");
    }
    const store = new FakeStore({ schema_version: 1, mode: "BROKEN", seq: 1, desired: { mode: "NORMAL" } });
    const ops = new Ops(store, new FakeBeacon(), gcp(), new FakeClock(), KEY, "k");
    await assert.rejects(deploy(ops, manifest(), SCHEMA, DI), DeployRejected);
  });
  it("a live start/stop lease blocks the deploy", async () => {
    const s = S.acquireLease(stateIn("NORMAL"), "ops-stop-run", "stop", "2026-11-01T10:00:00Z", false);
    const store = new FakeStore(s);
    const g = gcp();
    await assert.rejects(deploy(new Ops(store, new FakeBeacon(), g, new FakeClock(), KEY, "k"), manifest(), SCHEMA, DI), DeployRejected);
    assert.deepEqual(g.calls, []);
  });
  it("failed health check fails", async () => {
    const g = gcp();
    g.health["jra-bot-dashboard"] = 503;
    await rejected(manifest(), "NORMAL", g);
  });
  it("ingress change during deploy is detected", async () => {
    const g = gcp();
    g.hooks.serviceSetImage = async (n, i) => {
      g.calls.push(`svc-image:${n}`);
      g.serviceImages[n] = i;
      g.svc(n).ingress = "internal";
    };
    await rejected(manifest(), "NORMAL", g);
  });
});

describe("rollback judgement (CONTRACTS §10)", () => {
  it("version compare is numeric", () => {
    assert.ok(compareVersions("2026.10.10", "2026.10.9") > 0);
    assert.throws(() => compareVersions("latest", "1"), DeployRejected);
  });
  it("first deploy and newer releases are forward; same release is a redeploy", () => {
    const m = checkManifest(manifest(), SCHEMA, PRJ).manifest;
    assert.ok(m);
    assert.equal(judge(m, null).kind, "forward");
    assert.equal(judge(m, REL("2026.10.0", "2026.10.0", "4")).kind, "forward");
    assert.deepEqual(judge(m, { ...REL("2026.11.0", "2026.11.0", "5"), git_sha: "b".repeat(40) }), { kind: "redeploy", problems: [] });
    assert.ok(judge(m, REL("2026.11.0", "2026.11.0", "5")).problems.length > 0, "同じ release で git_sha が違えば拒否");
  });
  it("rollback is allowed only down to the min_app_release of the applied schema", () => {
    const m = checkManifest(manifest({ release: "2026.11.1", rollback: { min_app_release: "2026.11.0" } }), SCHEMA, PRJ).manifest;
    assert.ok(m);
    assert.deepEqual(judge(m, REL("2026.11.3", "2026.11.0", "5")), { kind: "rollback", problems: [] });
    assert.ok(judge(m, REL("2026.11.3", "2026.11.2", "5")).problems.some((p) => p.includes("2026.11.2")));
    const needsNewer = checkManifest(
      manifest({ release: "2026.11.1", required_schema_version: "6", flyway: { latest_version: "6", baseline: "1" } }),
      SCHEMA,
      PRJ,
    ).manifest;
    assert.ok(needsNewer);
    assert.ok(judge(needsNewer, REL("2026.11.3", "2026.11.0", "5")).problems.some((p) => p.includes("スキーマ版")));
  });
  it("a rollback deploy never changes the db-migration image nor migrates, and keeps the schema record", async () => {
    const g = gcp();
    g.jobImages["jra-bot-db-migration"] = "newer";
    const { out, store } = await run(manifest({ release: "2026.11.0" }), "NORMAL", g, {}, REL("2026.11.2", "2026.10.0", "5"));
    assert.equal(out.kind, "rollback");
    assert.equal(g.jobImages["jra-bot-db-migration"], "newer");
    assert.ok(!g.calls.includes("job:jra-bot-db-migration:--mode=migrate"));
    assert.ok(g.calls.includes("job:jra-bot-db-migration:--mode=validate"), "現在の db-migration で DB の健全性だけ確認する");
    const s = S.validate(store.state);
    assert.equal(s.release?.app_release, "2026.11.0");
    assert.equal(s.release?.schema_min_app_release, "2026.10.0", "DB は戻らないので schema の記録は下げない");
    assert.equal(s.release?.schema_flyway_version, "5");
  });
  it("a rollback below the allowed range is refused before anything changes", async () => {
    const g = gcp();
    const { err } = await rejected(manifest({ release: "2026.11.0" }), "NORMAL", g, {}, REL("2026.11.5", "2026.11.3", "5"));
    assert.match(err.message, /ロールバック判定/);
    assert.ok(!g.calls.some((c) => c.startsWith("job") || c.startsWith("svc-image")));
  });
});

describe("review fixes (Opus L2 review)", () => {
  it("rejections write nothing: STOPPED without permission, rollback refusal, missing or broken ops-state, live lease", async () => {
    const { store } = await rejected(manifest(), "STOPPED", gcp("internal"));
    assert.equal(store.writes, 0);
    const r2 = await rejected(manifest({ release: "2026.11.0" }), "NORMAL", gcp(), {}, REL("2026.11.5", "2026.11.3", "5"));
    assert.equal(r2.store.writes, 0);
    const empty = new FakeStore();
    await assert.rejects(
      deploy(new Ops(empty, new FakeBeacon(), gcp(), new FakeClock(), undefined, "k"), manifest(), SCHEMA, DI),
      /UNKNOWN/,
    );
    assert.equal(empty.state, undefined, "初期化もしない");
    const leased = new FakeStore(S.acquireLease(stateIn("NORMAL"), "ops-stop-run", "stop", "2026-11-01T10:00:00Z", false));
    await assert.rejects(
      deploy(new Ops(leased, new FakeBeacon(), gcp(), new FakeClock(), undefined, "k"), manifest(), SCHEMA, DI),
      DeployRejected,
    );
    assert.equal(leased.writes, 0);
  });
  it("a STOPPED forward deploy raises the rollback lower bound so a later start-with-migrate cannot be rolled back below it", async () => {
    // A を NORMAL で deploy → 停止 → 互換性を壊す B（min_app_release=B）を STOPPED で deploy → A へのロールバックは拒否
    const g = gcp("internal");
    const a = REL("2026.11.0", "2026.11.0", "5");
    const { store } = await run(
      manifest({ release: "2026.11.4", rollback: { min_app_release: "2026.11.4" }, git_sha: "d".repeat(40) }),
      "STOPPED",
      g,
      { allowWhenStopped: true },
      a,
    );
    const s = S.validate(store.state);
    assert.equal(s.release?.schema_min_app_release, "2026.11.4", "下限を安全側に上げる");
    assert.equal(s.release?.schema_flyway_version, "5", "適用済みの版は migrate したときだけ上げる");
    const st = S.validate(store.state);
    st.mode = "NORMAL";
    const back = new FakeStore(st);
    await assert.rejects(
      deploy(new Ops(back, new FakeBeacon(), gcp(), new FakeClock(), undefined, "k"), manifest({ release: "2026.11.0" }), SCHEMA, DI),
      /ロールバック判定/,
    );
  });
  it("deploy does not overwrite last_actual measured by start/stop (the deploy SA cannot read Cloud SQL / Scheduler)", async () => {
    const st = stateIn("NORMAL");
    st.last_actual = { captured_at: "2026-11-01T09:00:00Z", db: "RUNNABLE" };
    const store = new FakeStore(st);
    await deploy(new Ops(store, new FakeBeacon(), gcp(), new FakeClock(), undefined, "k"), manifest(), SCHEMA, DI);
    assert.deepEqual(S.validate(store.state).last_actual, { captured_at: "2026-11-01T09:00:00Z", db: "RUNNABLE" });
  });
});
