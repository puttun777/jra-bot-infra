/** gcloud / GCS アダプタ（旧 ops/tests/test_adapters.py の全ケース + GCS JSON API の CAS と generation の bigint）。実 GCP には接続しない。 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GcloudAdapter, GcloudError, type Runner } from "../src/gcp/gcloud.js";
import { type Fetch, GcsBeaconStore, GcsClient, GcsStateStore, parseGeneration } from "../src/gcp/gcs.js";
import { ConflictError, UnknownOutcomeError } from "../src/ports.js";

class FakeRunner {
  calls: string[][] = [];
  constructor(readonly responses: Record<string, [number, string]> = {}) {}
  run: Runner = async (cmd) => {
    this.calls.push([...cmd]);
    const joined = cmd.join(" ");
    for (const [key, [code, out]] of Object.entries(this.responses)) if (joined.includes(key)) return { code, out };
    return { code: 0, out: "null" };
  };
}

function adapter(
  responses: Record<string, [number, string]> = {},
  http?: (url: string, tok: string | undefined) => Promise<number>,
  idToken?: () => Promise<string>,
) {
  const r = new FakeRunner(responses);
  return { a: new GcloudAdapter("proj", "asia-northeast1", r.run, http, idToken), r };
}

describe("gcloud adapter", () => {
  it("sql state is parsed", async () => {
    const { a } = adapter({
      "sql instances describe": [
        0,
        JSON.stringify({
          state: "RUNNABLE",
          settings: { activationPolicy: "ALWAYS", edition: "ENTERPRISE" },
          databaseVersion: "MYSQL_8_4",
        }),
      ],
    });
    assert.deepEqual(await a.sqlState(), { state: "RUNNABLE", activationPolicy: "ALWAYS" });
  });
  it("activation and ingress validate their arguments", async () => {
    const { a, r } = adapter();
    await assert.rejects(a.sqlSetActivation(JSON.parse('"ON_DEMAND"')), GcloudError);
    await assert.rejects(a.serviceSetIngress("x", JSON.parse('"internal-and-cloud-load-balancing"')), GcloudError);
    await a.sqlSetActivation("NEVER");
    await a.serviceSetIngress("jra-bot-dashboard", "internal");
    assert.ok(r.calls[0]?.includes("--activation-policy=NEVER"));
    assert.ok(r.calls[1]?.includes("--ingress=internal"));
    assert.ok(r.calls.every((c) => c.includes("--quiet") && c.includes("--project=proj")));
  });
  it("gcloud failure raises without leaking the full output", async () => {
    const { a } = adapter({ describe: [1, `${"x".repeat(1000)}ERR`] });
    await assert.rejects(a.sqlState(), (e: unknown) => e instanceof GcloudError && e.message.length < 300);
  });
  it("unexpected json shapes are rejected (fail closed)", async () => {
    const { a } = adapter({ "sql instances describe": [0, JSON.stringify({ state: 5 })] });
    await assert.rejects(a.sqlState(), /想定外/);
    const { a: b } = adapter({ "executions list": [0, JSON.stringify([{ status: {} }])] });
    await assert.rejects(b.runningExecutions(), /想定外/);
  });
  it("service state reads ingress, ready and iap members", async () => {
    const svc = {
      metadata: { annotations: { "run.googleapis.com/ingress": "internal", "run.googleapis.com/iap-enabled": "true" } },
      status: { url: "https://d", conditions: [{ type: "Ready", status: "True" }] },
    };
    const pol = {
      bindings: [
        { role: "roles/iap.httpsResourceAccessor", members: ["user:a@example.com"] },
        { role: "roles/other", members: ["user:b", "user:c"] },
      ],
    };
    const { a } = adapter({ "run services describe": [0, JSON.stringify(svc)], "iap web get-iam-policy": [0, JSON.stringify(pol)] });
    assert.deepEqual(await a.serviceState("jra-bot-dashboard"), {
      ingress: "internal",
      ready: true,
      iapEnabled: true,
      iapMembers: 1,
      url: "https://d",
    });
  });
  it("health sends an id token and the external probe sends none", async () => {
    const svc = JSON.stringify({ metadata: { annotations: {} }, status: { url: "https://d", conditions: [] } });
    const seen: [string, string | undefined][] = [];
    const { a } = adapter(
      { "run services describe": [0, svc] },
      async (url, tok) => {
        seen.push([url, tok]);
        return 200;
      },
      async () => "TOK",
    );
    assert.equal(await a.serviceHealth("jra-bot-ingest", "/health/ready"), 200);
    assert.deepEqual(seen[0], ["https://d/health/ready", "TOK"]);
    seen.length = 0;
    const { a: a2 } = adapter({ "run services describe": [0, svc] }, async (url, tok) => {
      seen.push([url, tok]);
      return 404;
    });
    assert.equal(await a2.serviceReachableExternally("jra-bot-ingest"), false);
    assert.equal(seen[0]?.[1], undefined);
    const { a: a3 } = adapter({ "run services describe": [0, svc] }, async () => 200);
    assert.equal(await a3.serviceReachableExternally("jra-bot-ingest"), true);
  });
  it("running executions and run job exit code", async () => {
    const ex = [
      { metadata: { name: "e1" }, status: { runningCount: 1 } },
      { metadata: { name: "e2" }, status: { runningCount: 0, completionTime: "2026-11-01T00:00:00Z" } },
      { metadata: { name: "e3" }, status: { runningCount: 0 } }, // 開始待ちも実行中として数える
      { metadata: { name: "e4" }, status: { conditions: [{ type: "Completed", status: "False" }] } },
    ];
    const { a } = adapter({ "executions list": [0, JSON.stringify(ex)], "jobs execute": [1, "ERROR: ... exit(10) ..."] });
    assert.deepEqual(await a.runningExecutions(), ["e1", "e3"]);
    assert.equal(await a.runJob("jra-bot-db-migration", ["--mode=validate"]), 10);
    assert.equal(await adapter({ "jobs execute": [1, "boom"] }).a.runJob("j", ["--mode=validate"]), 1);
    // 実行前から存在した execution の終了コードを拾わない
    const old = [{ metadata: { name: "old-exec" }, status: { conditions: [{ message: "Container called exit(10)." }] } }];
    assert.equal(
      await adapter({ "jobs execute": [1, "boom"], "executions list": [0, JSON.stringify(old)] }).a.runJob("j", ["--mode=validate"]),
      1,
    );
    // 今回できた execution の記述から探す
    let listed = 0;
    const seqRunner: Runner = async (cmd) => {
      const joined = cmd.join(" ");
      if (joined.includes("executions list")) {
        listed++;
        const fresh = { metadata: { name: "new-exec" }, status: { conditions: [{ message: "Container called exit(10)." }] } };
        return { code: 0, out: JSON.stringify(listed > 1 ? [fresh] : []) };
      }
      if (joined.includes("jobs execute")) return { code: 1, out: "boom" };
      return { code: 0, out: "null" };
    };
    assert.equal(await new GcloudAdapter("proj", "asia-northeast1", seqRunner).runJob("j", ["--mode=validate"]), 10);
  });
  it("job image is read from the job description", async () => {
    const d = { spec: { template: { spec: { template: { spec: { containers: [{ image: `img@sha256:${"a".repeat(64)}` }] } } } } } };
    assert.equal(await adapter({ "jobs describe": [0, JSON.stringify(d)] }).a.jobImage("j"), `img@sha256:${"a".repeat(64)}`);
    assert.equal(await adapter({ "jobs describe": [1, "NOT_FOUND"] }).a.jobImage("j"), undefined);
  });
  it("scheduler states", async () => {
    const d = [{ name: "projects/p/locations/l/jobs/jra-bot-reconcile", state: "PAUSED" }];
    assert.deepEqual(await adapter({ "scheduler jobs list": [0, JSON.stringify(d)] }).a.schedulerStates(), {
      "jra-bot-reconcile": "PAUSED",
    });
  });
});

/** GCS JSON API の偽物（オブジェクトと generation。int64 を文字列で返す本物の形に合わせる）。 */
class FakeGcs {
  objects = new Map<string, { body: Buffer; gen: bigint; cacheControl: string | undefined }>();
  requests: { method: string; url: string }[] = [];
  nextStatus: number | undefined;
  throwNext = false;
  gen = 9_007_199_254_740_990n; // 2^53 付近から始める（number へ変換すると精度が落ちる値）
  fetch: Fetch = async (url, init) => {
    this.requests.push({ method: init.method, url });
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error("ECONNRESET");
    }
    const u = new URL(url);
    const respond = (status: number, body = "", headers: Record<string, string> = {}) => ({
      status,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      text: async () => body,
    });
    if (this.nextStatus !== undefined) {
      const s = this.nextStatus;
      this.nextStatus = undefined;
      return respond(s);
    }
    if (init.method === "GET") {
      const name = decodeURIComponent(u.pathname.split("/o/")[1] ?? "");
      const o = this.objects.get(name);
      return o === undefined ? respond(404) : respond(200, o.body.toString("utf8"), { "x-goog-generation": o.gen.toString() });
    }
    const body = init.body ?? Buffer.alloc(0);
    const text = body.toString("utf8");
    const meta = JSON.parse(text.split("\r\n\r\n")[1]?.split("\r\n--")[0] ?? "{}") as { name: string; cacheControl?: string };
    const data = text.split("\r\n\r\n")[2]?.split("\r\n--jrabot-")[0] ?? "";
    const cur = this.objects.get(meta.name);
    const want = u.searchParams.get("ifGenerationMatch");
    if (want !== null && BigInt(want) !== (cur?.gen ?? 0n)) return respond(412);
    this.gen += 1n;
    this.objects.set(meta.name, { body: Buffer.from(data), gen: this.gen, cacheControl: meta.cacheControl });
    return respond(200, JSON.stringify({ name: meta.name, generation: this.gen.toString() }));
  };
}

describe("interrupt and GCS (Opus review: high)", () => {
  it("after SIGTERM the real GCS store can still write the lease release and the FAILED record", async () => {
    const { Ops } = await import("../src/engine.js");
    const S = await import("../src/state.js");
    const { FakeBeacon, FakeClock, FakeGcp } = await import("./fakes.js");
    const f = new FakeGcs();
    // 渡された signal を尊重する fetch（実際の fetch と同じく、abort 済みなら即座に失敗する）
    const honoring: Fetch = async (url, init) => {
      if (init.signal?.aborted === true) throw new Error("This operation was aborted");
      return f.fetch(url, init);
    };
    const store = new GcsStateStore(new GcsClient(honoring, async () => "T"), "b");
    const init = S.initialState("2026-11-01T09:00:00Z");
    await store.write(init, 0n);
    const ac = new AbortController();
    const g = new FakeGcp();
    g.hooks.sqlSetActivation = async () => {
      ac.abort("SIGTERM");
      throw new (await import("../src/ports.js")).Interrupted("SIGTERM");
    };
    const { generateKeyPairSync } = await import("node:crypto");
    const ops = new Ops(store, new FakeBeacon(), g, new FakeClock(), generateKeyPairSync("ed25519").privateKey, "k", undefined, ac.signal);
    await assert.rejects(ops.start({ actor: "a", reason: "r", runId: "run-x" }));
    const after = S.validate((await store.read()).raw);
    assert.equal(after.lease, null, "リースを解放した");
    assert.equal(after.operation?.status, "FAILED", "FAILED を記録した");
  });
  it("an interrupted gcloud run job is reported as interrupted, not as a schema failure", async () => {
    const ac = new AbortController();
    const r: Runner = async (cmd) => {
      if (cmd.join(" ").includes("jobs execute")) {
        ac.abort("SIGTERM");
        return { code: 127, out: "killed" };
      }
      return { code: 0, out: "[]" };
    };
    const a = new GcloudAdapter("proj", "asia-northeast1", r, undefined, undefined, ac.signal);
    await assert.rejects(a.runJob("jra-bot-db-migration", ["--mode=validate"]), /中断/);
  });
});

describe("gcs stores", () => {
  const client = (f: FakeGcs) => new GcsClient(f.fetch, async () => "TOKEN");
  it("read, write, CAS and conflict with int64 generations kept exact (bigint)", async () => {
    const f = new FakeGcs();
    const s = new GcsStateStore(client(f), "proj-ops-state");
    assert.deepEqual(await s.read(), { raw: undefined, generation: 0n });
    const g1 = await s.write({ seq: 1 }, 0n);
    assert.equal(g1, 9_007_199_254_740_991n);
    assert.deepEqual(await s.read(), { raw: { seq: 1 }, generation: g1 });
    await assert.rejects(s.write({ seq: 2 }, 0n), ConflictError);
    const g2 = await s.write({ seq: 2 }, g1);
    assert.equal(g2, 9_007_199_254_740_992n);
    const g3 = await s.write({ seq: 3 }, g2);
    assert.equal(g3 - g2, 1n, "2^53 を超えても 1 ずつ区別できる");
    assert.ok(f.requests.every((r) => !r.url.includes("9007199254740992.0")));
  });
  it("transport errors and 5xx/429 on write are an unknown outcome, not a conflict", async () => {
    const f = new FakeGcs();
    const s = new GcsStateStore(client(f), "b");
    f.throwNext = true;
    await assert.rejects(s.write({ a: 1 }, 0n), UnknownOutcomeError);
    for (const code of [408, 429, 500, 503]) {
      f.nextStatus = code;
      await assert.rejects(s.write({ a: 1 }, 0n), UnknownOutcomeError);
    }
    // 200 の後で本文を読めない（タイムアウト等）= 成立したかもしれない → 結果不明（呼出側が再読取りで確認する）
    const brokenBody: Fetch = async (url, init) => {
      const r = await f.fetch(url, init);
      return {
        status: r.status,
        headers: r.headers,
        text: async () => {
          throw new Error("body timeout");
        },
      };
    };
    await assert.rejects(new GcsStateStore(new GcsClient(brokenBody, async () => "T"), "b").write({ a: 2 }, 0n), UnknownOutcomeError);
    f.nextStatus = 403;
    await assert.rejects(s.write({ a: 1 }, 0n), /HTTP 403/);
  });
  it("history is append-only", async () => {
    const s = new GcsStateStore(client(new FakeGcs()), "b");
    await s.appendHistory("a", { x: 1 });
    await assert.rejects(s.appendHistory("a", { x: 2 }), ConflictError);
  });
  it("beacon is written with no-store", async () => {
    const f = new FakeGcs();
    await new GcsBeaconStore(client(f), "b").write(Buffer.from("{}"));
    assert.equal(f.objects.get("beacon/mode.json")?.cacheControl, "no-store");
  });
  it("generation strings are validated", () => {
    assert.equal(parseGeneration("1730000000000000001"), 1_730_000_000_000_000_001n);
    for (const bad of [undefined, 5, "-1", "1e3", "", "x"]) assert.throws(() => parseGeneration(bad));
  });
});
