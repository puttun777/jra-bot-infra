/** AWS の起動・停止の制御の判断（純粋な関数）。冪等性・競合・古い停止要求・閲覧と開催日の区別・停止し忘れの防止を確かめる。 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyRequest,
  beaconMode,
  computeWorkloads,
  DNS_SINKHOLE,
  type Effects,
  initialAwsState,
  jstToUtcMs,
  RequestRejected,
  reconcile,
  summarize,
} from "../src/aws/controller.js";
import { type ControllerPorts, runController } from "../src/aws/lambda.js";
import {
  type AwsOpsState,
  AwsOpsStateSchema,
  type CalendarPlan,
  DEFAULT_CONFIG,
  type HostStatus,
  type InstanceInfo,
  type Request,
  RequestSchema,
} from "../src/aws/model.js";
import { ConflictError } from "../src/ports.js";
import { MODES, type Mode } from "../src/state.js";

const cfg = DEFAULT_CONFIG;
const T0 = "2026-11-14T01:00:00Z"; // JST 10:00（土）
const at = (min: number): string => new Date(Date.parse(T0) + min * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const stopped: InstanceInfo = { state: "stopped", publicIp: undefined };
const running = (ip = "203.0.113.10"): InstanceInfo => ({ state: "running", publicIp: ip });

function host(over: Partial<HostStatus> = {}): HostStatus {
  return {
    schema_version: 1,
    instance_id: "i-0123456789abcdef0",
    boot_id: "0b1d2c3e-aaaa-bbbb-cccc-000000000001",
    reported_at: T0,
    seen_seq: 999,
    phase: "READY",
    ready: { mysql: true, dashboard: true, ingest: false },
    workloads_applied: { raceday: false, batch: false },
    bot_run: { running: false, date: null },
    batch: { running: false, job: null },
    raceday_done: [],
    ...over,
  };
}

const req = (r: Record<string, unknown>): Request => RequestSchema.parse(r);

/** 1 回分の収束（公開中のビーコンは前回書いたもの、と仮定する）。 */
function step(
  s: AwsOpsState,
  now: string,
  inst: InstanceInfo,
  h?: HostStatus,
  plan?: CalendarPlan,
  published?: Mode,
): { state: AwsOpsState; effects: Effects } {
  const recorded = MODES.find((m) => m === s.beacon?.mode);
  return reconcile(s, h, inst, plan ?? emptyPlan(now), now, cfg, published ?? recorded);
}

/** 開催日の無い新しい計画（計画が無いときの警告・保持の試験は明示的に undefined を渡す）。 */
function emptyPlan(now: string): CalendarPlan {
  return { schema_version: 1, tenant_id: 1, generated_at: now, days: [] };
}

function startedView(minutes = 60): AwsOpsState {
  const s0 = initialAwsState(T0);
  return applyRequest(s0, req({ action: "view", minutes, actor: "me" }), T0).state;
}

describe("閲覧用の起動（VIEW）", () => {
  it("STOPPED → STARTING（起動の要求とビーコン STARTING）。bot・ingest は許さない", () => {
    const r = step(startedView(), T0, stopped);
    assert.equal(r.state.mode, "STARTING");
    assert.equal(r.effects.start, true);
    assert.equal(r.effects.beacon, "STARTING");
    assert.deepEqual(r.state.workloads, { raceday: false, batch: false });
  });

  it("起動の受付と準備完了を区別する: ホストが起動後に READY を報告するまで NORMAL にしない", () => {
    let s = step(startedView(), T0, stopped).state;
    // EC2 は動いたが、ホストの報告は古い（起動の要求より前）
    let r = step(s, at(2), running(), host({ reported_at: at(-5) }));
    assert.equal(r.state.mode, "STARTING");
    assert.equal(r.effects.dnsIp, "203.0.113.10", "公開 IP が変わったら DNS を書き直す");
    assert.deepEqual(r.state.aws.last_dns, { ip: "203.0.113.10", at: at(2) }, "書いた IP は状態と一緒に記録する");
    s = r.state;
    r = step(s, at(3), running(), host({ reported_at: at(3), phase: "BOOTING" }));
    assert.equal(r.state.mode, "STARTING");
    r = step(s, at(4), running(), host({ reported_at: at(4) }));
    assert.equal(r.state.mode, "NORMAL");
    assert.equal(r.effects.dnsIp, undefined);
    // 閲覧だけなのでエージェントには送らせない（ビーコンは STOPPED のまま）
    assert.equal(r.effects.beacon, "STOPPED");
    assert.deepEqual(r.state.workloads, { raceday: false, batch: false });
    // 1 時間たったら同じ IP でも書き直す（前回の DNS の書込みの失敗を直す）
    r = step(r.state, at(63), running(), host({ reported_at: at(63) }));
    assert.equal(r.effects.dnsIp, "203.0.113.10");
  });

  it("期限で止まる: VIEW の hold が切れたら STOPPING、ホストの排出と EC2 の停止で STOPPED（クリーン・バックアップ成功）", () => {
    let s = step(startedView(60), T0, stopped).state;
    s = step(s, at(4), running(), host({ reported_at: at(4) })).state;
    assert.equal(s.mode, "NORMAL");
    let r = step(s, at(59), running(), host({ reported_at: at(59) }));
    assert.equal(r.state.mode, "NORMAL");
    r = step(r.state, at(61), running(), host({ reported_at: at(60) }));
    assert.equal(r.state.mode, "STOPPING");
    assert.equal(r.effects.beacon, "STOPPING");
    assert.equal(r.effects.stop, "none", "まずホストに排出させる（いきなり StopInstances しない）");
    const drained = host({
      reported_at: at(65),
      phase: "DRAINED",
      backup: { last_ok_at: at(64), last_failed_at: null, last_key: "k", last_error: null },
    });
    r = step(r.state, at(66), { state: "stopped", publicIp: undefined }, drained);
    assert.equal(r.state.mode, "STOPPED");
    assert.deepEqual(r.state.aws.last_stop, {
      at: at(66),
      clean: true,
      backup_ok: true,
      forced: false,
      reason: "hold が無い（期限切れ・解放）",
    });
    assert.equal(r.effects.notify.length, 0);
    assert.equal(r.effects.beacon, "STOPPED");
  });

  it("延長: 閲覧中の再要求は同じ hold の期限を延ばす（短くしない）。古い終了の要求は延長後の閲覧を止めない", () => {
    let s = startedView(60);
    const first = s.aws.holds[0];
    assert.ok(first);
    const ext = applyRequest(s, req({ action: "view", minutes: 30, actor: "me" }), at(10));
    assert.equal(ext.holdId, first.id);
    assert.equal(ext.state.aws.holds[0]?.expires_at, at(60), "短くはしない");
    s = applyRequest(ext.state, req({ action: "view", minutes: 120, actor: "me" }), at(20)).state;
    assert.equal(s.aws.holds[0]?.expires_at, at(140));
    // 延長（at 20）より前に出された終了の要求（at 15）は効かない
    const stale = applyRequest(s, req({ action: "view-end", actor: "me", requested_at: at(15) }), at(21));
    assert.equal(stale.state.aws.holds.length, 1);
    const fresh = applyRequest(s, req({ action: "view-end", actor: "me", requested_at: at(21) }), at(21));
    assert.equal(fresh.state.aws.holds.length, 0);
  });

  it("起動中の再要求は二重に起動しない（StartInstances は冪等。状態は STARTING のまま）", () => {
    const s = step(startedView(), T0, stopped).state;
    const again = applyRequest(s, req({ action: "view", minutes: 60, actor: "me" }), at(1)).state;
    const r = step(again, at(1), { state: "pending", publicIp: undefined });
    assert.equal(r.state.mode, "STARTING");
    assert.equal(r.effects.start, false, "pending の間は要求しない");
    assert.equal(r.state.aws.holds.length, 1);
  });

  it("起動の途中で hold が無くなったら止める", () => {
    const s = step(startedView(), T0, stopped).state;
    const ended = applyRequest(s, req({ action: "view-end", actor: "me", requested_at: at(1) }), at(1)).state;
    const r = step(ended, at(1), { state: "pending", publicIp: undefined });
    assert.equal(r.state.mode, "STOPPING");
  });

  it("停止の途中の起動の要求は、停止を終えてから起動し直す（中途の状態を作らない）", () => {
    let s = step(startedView(10), T0, stopped).state;
    s = step(s, at(3), running(), host({ reported_at: at(3) })).state;
    s = step(s, at(11), running(), host({ reported_at: at(11) })).state;
    assert.equal(s.mode, "STOPPING");
    s = applyRequest(s, req({ action: "view", minutes: 60, actor: "me" }), at(12)).state;
    let r = step(s, at(12), running(), host({ reported_at: at(12), phase: "DRAINING" }));
    assert.equal(r.state.mode, "STOPPING");
    assert.equal(r.effects.start, false);
    r = step(r.state, at(15), stopped, host({ reported_at: at(14), phase: "DRAINED" }));
    assert.equal(r.state.mode, "STOPPED");
    r = step(r.state, at(16), stopped);
    assert.equal(r.state.mode, "STARTING");
    assert.equal(r.effects.start, true);
  });
});

describe("停止の失敗の検知と停止し忘れの防止", () => {
  it("排出が終わらなければ StopInstances、さらに待って強制停止。クリーンでない停止は通知する", () => {
    let s = step(startedView(10), T0, stopped).state;
    s = step(s, at(3), running(), host({ reported_at: at(3) })).state;
    s = step(s, at(11), running(), host({ reported_at: at(11) })).state;
    assert.equal(s.mode, "STOPPING");
    let r = step(s, at(11 + cfg.drainTimeoutMinutes - 1), running(), host({ reported_at: at(20), phase: "DRAINING" }));
    assert.equal(r.effects.stop, "none");
    r = step(r.state, at(11 + cfg.drainTimeoutMinutes + 1), running(), host({ reported_at: at(30), phase: "DRAINING" }));
    assert.equal(r.effects.stop, "normal");
    assert.equal(r.effects.notify.length, 1);
    r = step(r.state, at(11 + cfg.drainTimeoutMinutes + 1 + cfg.forceStopAfterMinutes + 1), running(), undefined);
    assert.equal(r.effects.stop, "force");
    r = step(r.state, at(60), stopped, undefined);
    assert.equal(r.state.mode, "STOPPED");
    assert.equal(r.state.aws.last_stop?.clean, false);
    assert.equal(r.state.aws.last_stop?.forced, true);
    assert.ok(r.effects.notify.some((n) => n.title.includes("完了していない")));
  });

  it("制御を通さずに起動された EC2（STOPPED なのに動いている）は止める", () => {
    const r = step(initialAwsState(T0), T0, running());
    assert.equal(r.state.mode, "STOPPING");
    assert.equal(r.effects.notify.length, 1);
  });

  it("連続稼働の上限を超えたら hold を外して止め、今日の開催日を再び自動起動しない", () => {
    let s = step(startedView(240), T0, stopped).state;
    s = step(s, at(3), running(), host({ reported_at: at(3) })).state;
    s.aws.running_since = at(-cfg.maxRunningHours * 60 - 1);
    const r = step(s, at(4), running(), host({ reported_at: at(4) }));
    assert.equal(r.state.mode, "STOPPING");
    assert.equal(r.state.aws.holds.length, 0);
  });

  it("hold があるのに EC2 が止まった（障害・手動の停止）なら起動し直す", () => {
    let s = step(startedView(60), T0, stopped).state;
    s = step(s, at(3), running(), host({ reported_at: at(3) })).state;
    const r = step(s, at(10), stopped);
    assert.equal(r.state.mode, "STARTING");
    assert.equal(r.effects.start, true);
  });
});

describe("開催日（RACEDAY）", () => {
  const date = "2026-11-14";
  const plan: CalendarPlan = {
    schema_version: 1,
    tenant_id: 1,
    generated_at: "2026-11-08T09:00:00Z",
    days: [{ date, verdict: "CONFIRMED", first_post: "2026-11-14T00:55:00Z", last_post: "2026-11-14T07:40:00Z" }],
  };
  const firstPost = Date.parse("2026-11-14T00:55:00Z");
  const lead = (min: number): string =>
    new Date(firstPost - (cfg.racedayLeadMinutes - min) * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

  it("計画の窓（最初の発走の lead 分前）に入ったら自動で起動し、raceday を許す。窓の前は起動しない", () => {
    const s0 = initialAwsState(T0);
    assert.equal(reconcile(s0, undefined, stopped, plan, lead(-1), cfg, undefined).state.mode, "STOPPED");
    const r = reconcile(s0, undefined, stopped, plan, lead(0), cfg, undefined);
    assert.equal(r.state.mode, "STARTING");
    assert.deepEqual(r.state.workloads, { raceday: true, batch: false });
    assert.equal(r.state.aws.holds[0]?.id, `raceday-${date}`);
  });

  it("ビーコンが NORMAL になるのは開催日の処理中に ingest の準備ができたときだけ", () => {
    let s = reconcile(initialAwsState(T0), undefined, stopped, plan, lead(0), cfg, undefined).state;
    s = reconcile(s, host({ reported_at: lead(4) }), running(), plan, lead(4), cfg, "STARTING").state;
    assert.equal(s.mode, "NORMAL");
    assert.equal(beaconMode(s, host({ reported_at: lead(5) }), Date.parse(lead(5)), cfg), "STOPPED", "ingest が未準備");
    const ready = host({
      reported_at: lead(5),
      ready: { mysql: true, dashboard: true, ingest: true },
      workloads_applied: { raceday: true, batch: false },
    });
    assert.equal(beaconMode(s, ready, Date.parse(lead(5)), cfg), "NORMAL");
    assert.equal(
      beaconMode(s, ready, Date.parse(lead(5)) + (cfg.hostFreshSeconds + 1) * 1000, cfg),
      "STOPPED",
      "ホストの報告が古ければ送らせない",
    );
  });

  it("閲覧の期限切れは開催日の処理を止めない。ホストが終わりを報告したら RACEDAY の hold を外して止め、同じ日は再び起動しない", () => {
    let s = reconcile(initialAwsState(T0), undefined, stopped, plan, lead(0), cfg, undefined).state;
    s = applyRequest(s, req({ action: "view", minutes: 30, actor: "me" }), lead(1)).state;
    s = reconcile(s, host({ reported_at: lead(4) }), running(), plan, lead(4), cfg, "STARTING").state;
    // 閲覧の期限（30 分）が切れても RACEDAY があるので NORMAL のまま
    let r = reconcile(s, host({ reported_at: lead(40) }), running(), plan, lead(40), cfg, "STOPPED");
    assert.equal(r.state.mode, "NORMAL");
    assert.deepEqual(
      r.state.aws.holds.map((h) => h.purpose),
      ["RACEDAY"],
    );
    // 終わりの報告（hold を作った後の報告だけを信じる）
    const done = host({ reported_at: "2026-11-14T08:30:00Z", raceday_done: [date] });
    r = reconcile(r.state, done, running(), plan, "2026-11-14T08:31:00Z", cfg, "NORMAL");
    assert.equal(r.state.mode, "STOPPING");
    assert.deepEqual(r.state.aws.completed_racedays, [date]);
    r = reconcile(r.state, done, stopped, plan, "2026-11-14T08:40:00Z", cfg, "STOPPING");
    r = reconcile(r.state, done, stopped, plan, "2026-11-14T08:45:00Z", cfg, "STOPPED");
    assert.equal(r.state.mode, "STOPPED", "完了した日は窓の中でも再び起動しない");
  });

  it("窓の終わり（最後の発走 + tail）で hold は外れる（ホストの報告が無くても止まる）", () => {
    const end = Date.parse("2026-11-14T07:40:00Z") + cfg.racedayTailMinutes * 60_000;
    let s = reconcile(initialAwsState(T0), undefined, stopped, plan, lead(0), cfg, undefined).state;
    s = reconcile(s, host({ reported_at: lead(4) }), running(), plan, lead(4), cfg, "STARTING").state;
    const r = reconcile(s, undefined, running(), plan, new Date(end + 1000).toISOString().replace(/\.\d{3}Z$/, "Z"), cfg, "NORMAL");
    assert.equal(r.state.mode, "STOPPING");
  });

  it("飛ばす日・手動の登録（時刻が分からなければ既定の時刻）", () => {
    let s = applyRequest(initialAwsState(T0), req({ action: "raceday-skip", date, actor: "me", reason: "休み" }), T0).state;
    assert.equal(reconcile(s, undefined, stopped, plan, lead(0), cfg, undefined).state.mode, "STOPPED");
    s = applyRequest(s, req({ action: "raceday-add", date: "2026-11-23", actor: "me" }), T0).state;
    const start = jstToUtcMs("2026-11-23", cfg.defaultFirstPostJst) - cfg.racedayLeadMinutes * 60_000;
    const r = reconcile(s, undefined, stopped, undefined, new Date(start).toISOString().replace(/\.\d{3}Z$/, "Z"), cfg, undefined);
    assert.equal(r.state.mode, "STARTING", "祝日の開催も手動で登録できる");
    assert.equal(r.state.aws.holds[0]?.race_date, "2026-11-23");
  });

  it("重い処理は開催日の処理中は受け付けない。重い処理の途中で開催日が始まったら batch は許されなくなる（開催日が優先）", () => {
    let s = reconcile(initialAwsState(T0), undefined, stopped, plan, lead(0), cfg, undefined).state;
    assert.throws(() => applyRequest(s, req({ action: "batch", minutes: 120, actor: "me", reason: "backtest" }), lead(1)), RequestRejected);
    s = applyRequest(initialAwsState(T0), req({ action: "batch", minutes: 600, actor: "me", reason: "backtest" }), lead(-30)).state;
    assert.deepEqual(reconcile(s, undefined, stopped, plan, lead(-29), cfg, undefined).state.workloads, { raceday: false, batch: true });
    assert.deepEqual(reconcile(s, undefined, stopped, plan, lead(1), cfg, undefined).state.workloads, { raceday: true, batch: false });
    assert.deepEqual(computeWorkloads([]), { raceday: false, batch: false });
  });

  it("stop-all は要求の時刻より前の hold をすべて外し、今日の開催日を再び自動で起動しない", () => {
    let s = reconcile(initialAwsState(T0), undefined, stopped, plan, lead(0), cfg, undefined).state;
    s = applyRequest(s, req({ action: "stop-all", actor: "me", reason: "障害の調査", requested_at: lead(5) }), lead(6)).state;
    assert.equal(s.aws.holds.length, 0);
    assert.ok(s.aws.skip_dates.includes(date));
    const r = reconcile(s, host({ reported_at: lead(6) }), running(), plan, lead(7), cfg, "STARTING");
    assert.equal(r.state.mode, "STOPPING");
  });
});

describe("要求の検査と要約", () => {
  it("不正な要求は拒否（分の範囲・未知の action・余分な項目）", () => {
    for (const bad of [
      { action: "view", minutes: 5, actor: "me" },
      { action: "view", minutes: 241, actor: "me" },
      { action: "view", minutes: 60, actor: "me", extra: 1 },
      { action: "start-ec2" },
      { action: "stop-all", actor: "me", reason: "", requested_at: T0 },
    ]) {
      assert.equal(RequestSchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });

  it("要約は接続先を準備完了のときだけ出し、自動停止の予定・hold・最後の停止を含む", () => {
    let s = step(startedView(60), T0, stopped).state;
    let sum = summarize(s, undefined, stopped, T0, "https://jrabot.example.com");
    assert.equal(sum["usable"], false);
    assert.equal(sum["url"], null);
    s = step(s, at(3), running(), host({ reported_at: at(3) })).state;
    sum = summarize(s, host({ reported_at: at(3) }), running(), at(3), "https://jrabot.example.com");
    assert.equal(sum["usable"], true);
    assert.equal(sum["url"], "https://jrabot.example.com");
    assert.equal(sum["auto_stop_at"], at(60));
  });
});

describe("Lambda の 1 回分（runController）: CAS の競合・副作用・ビーコンの seq", () => {
  function fakePorts(initial: AwsOpsState | undefined, inst: InstanceInfo, h?: HostStatus) {
    let stored: { raw: unknown; etag: string } | undefined = initial === undefined ? undefined : { raw: initial, etag: "e0" };
    let n = 0;
    let conflictsLeft = 0;
    const calls: string[] = [];
    const ports: ControllerPorts = {
      readState: async () => (stored === undefined ? undefined : structuredClone(stored)),
      writeState: async (next, etag) => {
        if (conflictsLeft > 0) {
          conflictsLeft--;
          // 他の呼び出しが先に書いた（seq を 1 つ進めた状態にする）
          const other = structuredClone(stored?.raw ?? initialAwsState(T0)) as AwsOpsState;
          other.seq += 1;
          stored = { raw: other, etag: `x${++n}` };
          throw new ConflictError("412");
        }
        if ((stored?.etag ?? undefined) !== etag) throw new ConflictError("412");
        stored = { raw: structuredClone(next), etag: `e${++n}` };
        calls.push(`write:${next.mode}:${next.seq}`);
      },
      appendHistory: async () => {},
      readHost: async () => h,
      readPlan: async () => ({ schema_version: 1, tenant_id: 1, generated_at: T0, days: [] }),
      readBeacon: async () => undefined,
      describe: async () => inst,
      start: async () => {
        calls.push("start");
      },
      stop: async (force) => {
        calls.push(`stop:${force}`);
      },
      writeBeacon: async (mode, seq) => {
        calls.push(`beacon:${mode}:${seq}`);
      },
      upsertDns: async (ip) => {
        calls.push(`dns:${ip}`);
      },
      notify: async (title) => {
        calls.push(`notify:${title}`);
      },
    };
    return { ports, calls, stored: () => stored, conflict: (k: number) => (conflictsLeft = k) };
  }

  it("閲覧の要求: 状態を書いてから起動・ビーコン（ビーコンの seq は書いた状態の seq）", async () => {
    const f = fakePorts(undefined, stopped);
    const r = await runController(f.ports, req({ action: "view", minutes: 60, actor: "me" }), T0, cfg, undefined);
    assert.equal(r.ok, true);
    assert.ok(r.holdId?.startsWith("view-"));
    assert.deepEqual(f.calls, ["write:STARTING:2", "start", `dns:${DNS_SINKHOLE}`, "beacon:STARTING:2"]);
  });

  it("CAS が競合したら読み直して判断し直す（他の書込みを上書きしない）", async () => {
    const f = fakePorts(initialAwsState(T0), stopped);
    f.conflict(2);
    const r = await runController(f.ports, req({ action: "view", minutes: 60, actor: "me" }), T0, cfg, undefined);
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 2);
    const st = f.stored()?.raw as AwsOpsState;
    assert.equal(st.mode, "STARTING");
    assert.equal(st.seq, 4, "競合した 2 回の書込み（seq 2・3）の上に積む");
  });

  it("拒否された要求は状態を変えない。変化の無い定期実行は書かない", async () => {
    const plan: CalendarPlan = {
      schema_version: 1,
      tenant_id: 1,
      generated_at: T0,
      days: [{ date: "2026-11-14", verdict: "CONFIRMED", first_post: null, last_post: null }],
    };
    const s = reconcile(initialAwsState(T0), undefined, stopped, plan, T0, cfg, undefined).state;
    const f = fakePorts(s, { state: "pending", publicIp: undefined });
    const r = await runController(f.ports, req({ action: "batch", minutes: 60, actor: "me", reason: "x" }), T0, cfg, undefined);
    assert.equal(r.ok, false);
    assert.deepEqual(f.calls, []);
    const idle = fakePorts(initialAwsState(T0), stopped);
    await runController(idle.ports, req({ action: "tick" }), T0, cfg, undefined);
    assert.deepEqual(
      idle.calls,
      ["write:STOPPED:2", `dns:${DNS_SINKHOLE}`, "beacon:STOPPED:2"],
      "公開中のビーコンが無ければ、記録の seq を進めて書く",
    );
    idle.ports.readBeacon = async () => ({ mode: "STOPPED", seq: 2 });
    await runController(idle.ports, req({ action: "tick" }), at(5), cfg, undefined);
    assert.deepEqual(idle.calls, ["write:STOPPED:2", `dns:${DNS_SINKHOLE}`, "beacon:STOPPED:2"], "2 回目は何も書かない（冪等）");
  });
});

describe("レビューの指摘の修正（2026-11-13）", () => {
  it("止まったら DNS を文書用のアドレスに向ける（手放した IP を他人が拾っても届かない）", () => {
    const s = startedView(30);
    s.mode = "STOPPED";
    s.desired.mode = "STOPPED";
    s.aws.holds = [];
    s.aws.last_dns = { ip: "203.0.113.10", at: at(-10) };
    const r = step(s, T0, stopped);
    assert.equal(r.effects.dnsIp, DNS_SINKHOLE);
    assert.deepEqual(r.state.aws.last_dns, { ip: DNS_SINKHOLE, at: T0 });
    assert.equal(step(r.state, at(5), stopped).effects.dnsIp, undefined, "書いた後は 1 時間ごとまで書かない");
  });

  it("計画が読めないときは動いている開催日の hold を保ち、警告する。計画が読めれば窓どおり", () => {
    const plan: CalendarPlan = {
      schema_version: 1,
      tenant_id: 1,
      generated_at: T0,
      days: [{ date: "2026-11-14", verdict: "CONFIRMED", first_post: at(60), last_post: at(300) }],
    };
    let s = step(initialAwsState(at(-300)), T0, stopped, undefined, plan).state;
    assert.ok(s.aws.holds.some((h) => h.purpose === "RACEDAY"));
    const r = reconcile(s, undefined, running(), undefined, at(10), cfg, undefined);
    assert.ok(
      r.state.aws.holds.some((h) => h.purpose === "RACEDAY"),
      "計画の不具合で開催日の途中に止めない",
    );
    assert.ok(r.effects.notify.some((n) => n.title.includes("計画")));
    s = r.state;
    const later = reconcile(s, undefined, running(), undefined, at(300 + cfg.racedayTailMinutes + 1), cfg, undefined);
    assert.ok(!later.state.aws.holds.some((h) => h.purpose === "RACEDAY"), "期限が来れば外れる");
  });

  it("手動の開催日・飛ばす日の上限と日付の範囲を超える要求は拒否（状態を読めなくしない）", () => {
    let s = initialAwsState(T0);
    for (let i = 0; i < 30; i++) {
      const d = new Date(Date.parse("2026-11-15T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);
      s = applyRequest(s, { action: "raceday-add", date: d, first_post: null, last_post: null, actor: "t" }, T0).state;
    }
    assert.throws(
      () => applyRequest(s, { action: "raceday-add", date: "2026-12-30", first_post: null, last_post: null, actor: "t" }, T0),
      RequestRejected,
    );
    assert.throws(
      () =>
        applyRequest(initialAwsState(T0), { action: "raceday-add", date: "2027-06-01", first_post: null, last_post: null, actor: "t" }, T0),
      RequestRejected,
    );
    assert.throws(
      () => applyRequest(initialAwsState(T0), { action: "raceday-skip", date: "2026-01-01", actor: "t", reason: "r" }, T0),
      RequestRejected,
    );
    assert.ok(AwsOpsStateSchema.safeParse(s).success);
  });

  it("stopping のまま動かない EC2 は、排出と停止の猶予を超えたら強制停止して知らせる", () => {
    const s = startedView(30);
    s.mode = "STOPPING";
    s.desired.mode = "STOPPED";
    s.aws.holds = [];
    s.aws.stop_requested_at = T0;
    const stuck: InstanceInfo = { state: "stopping", publicIp: undefined };
    assert.equal(step(s, at(10), stuck).effects.stop, "none");
    const r = step(s, at(cfg.drainTimeoutMinutes + cfg.forceStopAfterMinutes + 1), stuck);
    assert.equal(r.effects.stop, "force");
    assert.ok(r.effects.notify.some((n) => n.title.includes("停止が終わらない")));
  });

  it("連続稼働の上限は開催日の hold がある間は適用しない（前夜からの batch で開催日を止めない）", () => {
    const plan: CalendarPlan = {
      schema_version: 1,
      tenant_id: 1,
      generated_at: T0,
      days: [{ date: "2026-11-14", verdict: "CONFIRMED", first_post: at(60), last_post: at(300) }],
    };
    const s = step(initialAwsState(at(-300)), T0, stopped, undefined, plan).state;
    s.mode = "NORMAL";
    s.desired.mode = "NORMAL";
    s.aws.running_since = at(-cfg.maxRunningHours * 60 - 10);
    const r = step(s, at(1), running(), host({ reported_at: at(1) }), plan);
    assert.ok(r.state.aws.holds.some((h) => h.purpose === "RACEDAY"));
    assert.equal(r.state.mode, "NORMAL");
  });

  it("閲覧の延長は本人の要求の時刻で記録し、その後に出された閲覧の終了は外すが、前に出された終了は外さない", () => {
    let s = applyRequest(initialAwsState(T0), { action: "view", minutes: 60, actor: "t", reason: "閲覧" }, T0).state;
    // 12:00:20 に出した延長が、12:00:00 に出した終了より先に処理された
    s = applyRequest(s, { action: "view", minutes: 60, actor: "t", reason: "閲覧", requested_at: at(1) }, at(3)).state;
    const kept = applyRequest(s, { action: "view-end", actor: "t", requested_at: at(0.5) }, at(4)).state;
    assert.ok(
      kept.aws.holds.some((h) => h.purpose === "VIEW"),
      "古い終了は新しい延長を外さない",
    );
    const ended = applyRequest(s, { action: "view-end", actor: "t", requested_at: at(2) }, at(4)).state;
    assert.ok(!ended.aws.holds.some((h) => h.purpose === "VIEW"));
    // 未来・1 時間より前の要求の時刻は信用しない（処理の時刻を使う）
    const future = applyRequest(initialAwsState(T0), { action: "view", minutes: 60, actor: "t", reason: "閲覧", requested_at: at(30) }, T0);
    assert.equal(future.state.aws.holds[0]?.updated_at, T0);
  });

  it("書く前の検査に通らない状態は書かない（以後の実行が読めなくなるのを防ぐ）", async () => {
    const st = startedView(120);
    const base = st.aws.holds[0];
    assert.ok(base !== undefined);
    st.aws.holds = Array.from({ length: 20 }, (_, i) => ({ ...base, id: `view-test-${i}` })); // 上限ちょうど
    let wrote = false;
    const ports: ControllerPorts = {
      readState: async () => ({ raw: structuredClone(st), etag: "e0" }),
      writeState: async () => {
        wrote = true;
      },
      appendHistory: async () => {},
      readHost: async () => undefined,
      readPlan: async () => ({ schema_version: 1, tenant_id: 1, generated_at: T0, days: [] }),
      readBeacon: async () => undefined,
      describe: async () => stopped,
      start: async () => {},
      stop: async () => {},
      writeBeacon: async () => {},
      upsertDns: async () => {},
      notify: async () => {},
    };
    const r = await runController(ports, { action: "maintenance", minutes: 30, actor: "t", reason: "r" }, at(1), cfg, undefined);
    assert.equal(r.ok, false);
    assert.match(r.message, /検査に失敗/);
    assert.equal(wrote, false);
  });
});
