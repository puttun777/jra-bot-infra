/** EC2 の上の運用エージェントの判断（純粋な関数）。閲覧用の起動で ingest・bot を動かさない・spool の検査・開催日の後処理・排出。 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type HostFacts, parseJobResult, planHost, SpoolRequestSchema } from "../src/aws/host.js";

const NOW = "2026-11-14T03:00:00Z"; // JST 12:00
const TODAY = "2026-11-14";
const cfg = { calendarIntervalSeconds: 300 };
const allUp = { mysql: "running", dashboard: "running", "oauth2-proxy": "running", caddy: "running" } as const;

function facts(over: Partial<HostFacts> = {}): HostFacts {
  return {
    now: NOW,
    ops: { seq: 5, mode: "NORMAL", raceday: false, batch: false },
    services: { ...allUp },
    botRun: { running: false, date: null },
    batch: { running: false, job: null },
    lastCalendar: undefined,
    spool: [],
    racedayDone: [],
    drained: false,
    prepared: true,
    ...over,
  };
}

const spool = (params: Record<string, string> = { trigger: "SCHEDULER", date: TODAY }) =>
  SpoolRequestSchema.parse({ schema_version: 1, job: "bot-run", tenant_id: 1, params, requested_at: "2026-11-14T02:59:00Z" });

describe("閲覧用の起動（raceday=false）", () => {
  it("基本のサービスだけを動かし、ingest は動かさない（動いていれば止める）。calendar-check もしない", () => {
    assert.deepEqual(planHost(facts({ services: {} }), cfg), [{ type: "up", services: ["mysql", "dashboard", "oauth2-proxy", "caddy"] }]);
    assert.deepEqual(planHost(facts({ services: { ...allUp, ingest: "running" } }), cfg), [{ type: "stop", services: ["ingest"] }]);
  });

  it("bot-run の起動依頼は捨て、動いている bot-run は止める（通知を始めない）", () => {
    const a = planHost(facts({ spool: [{ file: "bot-run-1.json", request: spool() }], botRun: { running: true, date: TODAY } }), cfg);
    assert.deepEqual(a, [
      { type: "stop-job", job: "bot-run" },
      { type: "discard-spool", file: "bot-run-1.json", reason: "開催日の処理が許されていない" },
    ]);
  });

  it("起動の準備が終わるまでアプリを動かさない。運用状態を読めない間は何もしない", () => {
    assert.deepEqual(planHost(facts({ prepared: false, services: {} }), cfg), []);
    assert.deepEqual(
      planHost(facts({ ops: undefined, services: { ...allUp, ingest: "running" }, botRun: { running: true, date: TODAY } }), cfg),
      [],
    );
  });
});

describe("開催日（raceday=true）", () => {
  const rd = { seq: 7, mode: "NORMAL" as const, raceday: true, batch: false };

  it("ingest を動かし、calendar-check を間隔ごとに実行する", () => {
    assert.deepEqual(planHost(facts({ ops: rd }), cfg), [{ type: "up", services: ["ingest"] }, { type: "calendar-check" }]);
    const recent = { at: "2026-11-14T02:58:00Z", reason: "LAUNCH_REQUESTED", date: TODAY };
    assert.deepEqual(planHost(facts({ ops: rd, services: { ...allUp, ingest: "running" }, lastCalendar: recent }), cfg), []);
    const old = { ...recent, at: "2026-11-14T02:54:00Z" };
    assert.deepEqual(planHost(facts({ ops: rd, services: { ...allUp, ingest: "running" }, lastCalendar: old }), cfg), [
      { type: "calendar-check" },
    ]);
  });

  it("spool の依頼で bot-run を起動する。実行中・別の日・形式違いは捨てる", () => {
    const up = { ...allUp, ingest: "running" } as const;
    const recent = { at: "2026-11-14T02:58:00Z", reason: "LAUNCH_REQUESTED", date: TODAY };
    assert.deepEqual(planHost(facts({ ops: rd, services: up, lastCalendar: recent, spool: [{ file: "a.json", request: spool() }] }), cfg), [
      { type: "launch-bot-run", file: "a.json", date: TODAY, trigger: "SCHEDULER" },
    ]);
    const a = planHost(
      facts({
        ops: rd,
        services: up,
        lastCalendar: recent,
        botRun: { running: true, date: TODAY },
        spool: [
          { file: "b.json", request: spool() },
          { file: "c.json", request: spool({ date: "2026-11-15" }) },
          { file: "d.json", request: undefined },
        ],
      }),
      cfg,
    );
    assert.deepEqual(
      a.map((x) => (x.type === "discard-spool" ? x.reason : x.type)),
      ["bot-run は実行中（リースが二重起動を防ぐ）", "今日の開催日ではない", "形式が不正"],
    );
    assert.equal(
      SpoolRequestSchema.safeParse({ schema_version: 1, job: "backtest", tenant_id: 1, params: {}, requested_at: NOW }).success,
      false,
    );
    assert.equal(
      SpoolRequestSchema.safeParse({
        schema_version: 1,
        job: "bot-run",
        tenant_id: 1,
        params: { date: TODAY, extra: "x" },
        requested_at: NOW,
      }).success,
      false,
    );
  });

  it("今日の処理が終わった（calendar-check の理由）で bot-run も終わっていれば後処理。終わった日は何もしない", () => {
    const up = { ...allUp, ingest: "running" } as const;
    const done = { at: "2026-11-14T02:58:00Z", reason: "AFTER_SETTLE_DEADLINE", date: TODAY };
    assert.deepEqual(planHost(facts({ ops: rd, services: up, lastCalendar: done }), cfg), [{ type: "finish-raceday", date: TODAY }]);
    assert.deepEqual(planHost(facts({ ops: rd, services: up, lastCalendar: done, botRun: { running: true, date: TODAY } }), cfg), []);
    assert.deepEqual(planHost(facts({ ops: rd, services: up, lastCalendar: done, racedayDone: [TODAY] }), cfg), []);
  });

  it("batch が許されていない重い処理は止める", () => {
    assert.deepEqual(
      planHost(
        facts({
          ops: rd,
          services: { ...allUp, ingest: "running" },
          batch: { running: true, job: "backtest" },
          lastCalendar: { at: NOW, reason: "BEFORE_WATCH_WINDOW", date: TODAY },
        }),
        cfg,
      ),
      [{ type: "stop-job", job: "batch" }],
    );
  });
});

describe("停止", () => {
  it("STOPPING・STOPPED なら排出（一度だけ）", () => {
    assert.deepEqual(planHost(facts({ ops: { seq: 9, mode: "STOPPING", raceday: false, batch: false } }), cfg), [{ type: "drain" }]);
    assert.deepEqual(planHost(facts({ ops: { seq: 9, mode: "STOPPED", raceday: false, batch: false } }), cfg), [{ type: "drain" }]);
    assert.deepEqual(planHost(facts({ ops: { seq: 9, mode: "STOPPING", raceday: false, batch: false }, drained: true }), cfg), []);
  });
});

describe("JOB_RESULT の行", () => {
  it("最後の結果の理由と終了コードを取り出し、形の違う行は無視する", () => {
    const log = [
      "x JOB_RESULT task=calendar-check tenant=1 exit=0 reason=BEFORE_WATCH_WINDOW",
      "y JOB_RESULT task=calendar-check tenant=1 exit=75 reason=SCHEDULE_UNKNOWN",
      "z JOB_RESULT task=bot-run tenant=1 exit=0 reason=ALL_SETTLED",
    ].join("\n");
    assert.deepEqual(parseJobResult(log, "calendar-check"), { exit: 75, reason: "SCHEDULE_UNKNOWN" });
    assert.deepEqual(parseJobResult(log, "bot-run"), { exit: 0, reason: "ALL_SETTLED" });
    assert.equal(parseJobResult("JOB_RESULT task=calendar-check tenant=1 exit=0 reason=bad;rm", "calendar-check"), undefined);
  });
});
