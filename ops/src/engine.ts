/**
 * start / stop のステップ実行（OPERATIONS_DESIGN §5・§6）。旧 ops/jrabot_ops/engine.py の移植。
 *
 * 原則: ① 状態（GCS）を**最初に**変えてからリソースを操作する ② 状態の書込みに失敗したらその時点で中断 ③ 各ステップは冪等（実状態を測ってスキップできる）
 * ④ 途中の失敗は STARTING / STOPPING のまま（**失敗を理由に NORMAL へ戻さない**）⑤ 認証設定（IAP・IAM・許可リスト）は変更しない。
 *
 * 移植時に直した既知の問題（LANGUAGE_MIGRATION §6）:
 *  1. dry-run は**何も書かない**（旧版はリースと operation を書いてから戻していたため、前回の失敗記録＝再実行の続きの情報を上書きしていた）。
 *  2/3. CAS の応答が失われた・412 になった場合は**再読取りして自分の書込みが成立しているか**を確認する（成立していれば成功、他者の書込みなら競合で中断。
 *       412 を一律に成功・失敗のどちらにも扱わない）。
 *  5. 中断（SIGINT/SIGTERM）はステップの境目・待機中に検知し、リースの解放と FAILED の記録を**最優先**で書く（計測は中断時は行わない）。
 */
import type { KeyObject } from "node:crypto";
import { makeBeacon } from "./beacon.js";
import { canonicalEqual, errorMessage } from "./json.js";
import {
  type BeaconStore,
  type Clock,
  ConflictError,
  type Gcp,
  type Generation,
  Interrupted,
  type StateStore,
  UnknownOutcomeError,
} from "./ports.js";
import * as S from "./state.js";

export const SERVICES = ["jra-bot-ingest", "jra-bot-dashboard"] as const;
export const SCHEDULER_JOBS = ["jra-bot-calendar-check", "jra-bot-reconcile", "jra-bot-retention"] as const;
export const DB_JOB = "jra-bot-db-migration";
const DB_START_TIMEOUT_S = 20 * 60;
const DB_POLL_S = 15;
const DRAIN_POLL_S = 20;
const POST_DRAIN_WAIT_S = 60;
/** CAS の書込みを結果不明のあとに再試行する回数 */
const WRITE_ATTEMPTS = 3;

export class StepFailed extends Error {
  override readonly name = "StepFailed";
}

export interface Inputs {
  readonly actor: string;
  readonly reason: string;
  readonly runId: string;
  readonly runUrl?: string;
  readonly force?: boolean;
  readonly dryRun?: boolean;
  /** start */
  readonly applyPendingMigrations?: boolean;
  /** stop */
  readonly drainTimeoutMin?: number;
  /** stop */
  readonly takeBackup?: boolean;
}

export interface DryRunReport {
  readonly dryRun: true;
  readonly kind: S.TransitionKind;
  readonly mode: S.Mode;
  readonly wouldTakeLease: boolean;
}

export type Notifier = (title: string, body: string) => void;

export class Ops {
  state: S.OpsState = S.initialState("1970-01-01T00:00:00Z");
  gen: Generation = 0n;
  notify: Notifier;

  constructor(
    readonly store: StateStore,
    readonly beaconStore: BeaconStore,
    readonly gcp: Gcp,
    readonly clock: Clock,
    /** ビーコンの署名鍵。deploy はビーコンを書かないので持たない（undefined） */
    readonly key: KeyObject | undefined,
    readonly kid: string,
    notifier?: Notifier,
    readonly signal: AbortSignal = new AbortController().signal,
  ) {
    this.notify = notifier ?? (() => {});
  }

  // ------------------------------------------------------------------ 状態の読み書き（CAS）
  /** 読むだけ（初期化もしない）。dry-run と status 用。 */
  async peek(): Promise<S.OpsState> {
    const { raw } = await this.store.read();
    return raw === undefined ? S.initialState(this.clock.now()) : S.validate(raw);
  }

  async load(): Promise<void> {
    const { raw, generation } = await this.store.read();
    if (raw === undefined) {
      const init = S.initialState(this.clock.now());
      this.gen = 0n;
      await this.writeVerified(init, "init");
      this.state = init;
      return;
    }
    this.state = S.validate(raw);
    this.gen = generation;
  }

  /**
   * CAS 書込み。結果が分からない・412 のときは再読取りして、**読めた内容が自分の書いた内容と完全に同じなら成立**とみなす
   * （operation.id・seq・時刻を含むので、他者が偶然同じ内容を書くことはない）。他者の書込みなら StepFailed（中断）。
   */
  private async writeVerified(next: S.OpsState, label: string): Promise<void> {
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
      try {
        this.gen = await this.store.write(next, this.gen);
        return;
      } catch (e) {
        if (!(e instanceof ConflictError) && !(e instanceof UnknownOutcomeError)) throw e;
        let current: { raw: unknown; generation: Generation };
        try {
          current = await this.store.read();
        } catch (re) {
          throw new StepFailed(`状態の書込みの成否を確認できない（${label}）: ${errorMessage(re)}`);
        }
        if (current.raw !== undefined && canonicalEqual(current.raw, next)) {
          this.gen = current.generation; // 応答だけが失われた / 再試行の 412 は自分の前回の書込み
          return;
        }
        if (e instanceof ConflictError || current.generation !== this.gen) {
          throw new StepFailed(`状態の書込みが競合した（他の操作が先に書いた）: ${label}`);
        }
        // 結果不明で generation も変わっていない → 書込みは成立していない。再試行する
        if (attempt === WRITE_ATTEMPTS) throw new StepFailed(`状態を書けない（${WRITE_ATTEMPTS} 回）: ${label}: ${errorMessage(e)}`);
      }
    }
  }

  async commit(next: S.OpsState, label: string): Promise<void> {
    const bumped = S.bump(next);
    await this.writeVerified(bumped, label);
    this.state = bumped;
    const type = bumped.operation?.type ?? "init";
    // 中断の後は履歴を省く（SIGKILL までの猶予に本体の状態の書込みを優先する。本体の状態に同じ内容がある）
    if (this.signal.aborted) return;
    try {
      await this.store.appendHistory(`${this.clock.now()}-${type}-${label}-${bumped.seq}`, bumped);
    } catch {
      // 履歴は監査の補助。本体の状態は書けているので、履歴の失敗で操作を止めない
    }
  }

  private checkAbort(): void {
    if (this.signal.aborted) throw new Interrupted(String(this.signal.reason ?? "中断"));
  }

  private async writeBeacon(mode: S.Mode): Promise<string> {
    if (this.key === undefined) throw new StepFailed("ビーコンの署名鍵が無い（この操作はビーコンを書けない）");
    const raw = makeBeacon(this.key, this.kid, mode, this.state.seq, this.clock.now());
    await this.beaconStore.write(raw);
    const s = structuredClone(this.state);
    s.beacon = { seq: this.state.seq, mode, updated_at: this.clock.now(), kid: this.kid };
    await this.commit(s, `beacon-${mode}`);
    return mode;
  }

  // ------------------------------------------------------------------ ステップ
  async step(name: string, fn: () => Promise<string | undefined>): Promise<void> {
    if (S.stepDone(this.state, name)) return;
    this.checkAbort();
    await this.commit(S.recordStep(this.state, name, "RUNNING", this.clock.now()), `${name}-begin`);
    let detail: string;
    try {
      detail = (await fn()) ?? "";
    } catch (e) {
      const msg = e instanceof StepFailed || e instanceof Interrupted ? e.message : errorMessage(e).slice(0, 300);
      try {
        await this.commit(S.recordStep(this.state, name, "FAILED", this.clock.now(), msg), `${name}-failed`);
      } catch {
        // 記録できなくても元の失敗を伝える
      }
      if (e instanceof StepFailed || e instanceof Interrupted || e instanceof S.Rejected) throw e;
      throw new StepFailed(msg);
    }
    await this.commit(S.recordStep(this.state, name, "DONE", this.clock.now(), detail), `${name}-done`);
  }

  // ------------------------------------------------------------------ 共通の開始・終了
  async begin(op: S.OpType, i: Inputs): Promise<S.TransitionKind> {
    await this.load();
    const kind = S.checkTransition(this.state, op, i.force ?? false);
    if (i.force === true && i.reason.trim() === "") throw new S.Rejected("force=true には理由が必要");
    let s = S.acquireLease(this.state, i.runId, op, this.clock.now(), i.force ?? false);
    s = S.withOperation(
      s,
      op,
      i.runId,
      i.actor,
      i.runUrl ?? "",
      i.force ?? false,
      this.clock.now(),
      kind === "resume" || kind === "repair",
    );
    await this.commit(s, `${op}-lease`);
    return kind;
  }

  /** dry-run: 状態を読み、遷移とリースの可否だけを判定する。**何も書かない**（既知の問題 1 の修正）。 */
  async dryRun(op: S.OpType, i: Inputs): Promise<DryRunReport> {
    const st = await this.peek();
    const kind = S.checkTransition(st, op, i.force ?? false);
    if (i.force === true && i.reason.trim() === "") throw new S.Rejected("force=true には理由が必要");
    const problem = S.leaseProblem(st, i.runId, op, this.clock.now(), i.force ?? false);
    if (problem !== undefined) throw new S.Rejected(problem);
    return { dryRun: true, kind, mode: st.mode, wouldTakeLease: true };
  }

  /**
   * 操作の終了。**先にリースの解放と結果（FAILED/SUCCEEDED）を書く**。実状態の計測は後から別の書込みで行い、失敗しても無視する。
   * 中断されたときは計測しない（キャンセルの猶予〔SIGINT から SIGKILL まで約 10 秒〕に収まらないことがある）。
   */
  async end(ok: boolean, error: string | null, measure = true): Promise<void> {
    let s = S.finish(this.state, ok, this.clock.now(), error);
    s = S.releaseLease(s, this.state.lease?.holder ?? "");
    await this.commit(s, "end");
    if (!measure) return;
    const measured = structuredClone(this.state);
    if (this.signal.aborted) {
      measured.last_actual = { captured_at: this.clock.now(), error: "中断されたため計測していない" };
    } else {
      try {
        measured.last_actual = await this.measure();
      } catch (e) {
        measured.last_actual = { captured_at: this.clock.now(), error: errorMessage(e).slice(0, 200) };
      }
    }
    try {
      await this.commit(measured, "end-measured");
    } catch {
      // 計測の記録は補助
    }
  }

  async measure(): Promise<Record<string, unknown>> {
    const sql = await this.gcp.sqlState();
    return {
      captured_at: this.clock.now(),
      db: sql.state ?? null,
      dashboard_ingress: (await this.gcp.serviceState(SERVICES[1])).ingress,
      ingest_ingress: (await this.gcp.serviceState(SERVICES[0])).ingress,
      scheduler: await this.gcp.schedulerStates(),
      running_executions: (await this.gcp.runningExecutions()).length,
    };
  }

  /** 例外を受けて、リースの解放と失敗の記録を行い、分類して投げ直す。 */
  private async fail(op: string, e: unknown): Promise<never> {
    const msg = e instanceof Error && e.message !== "" ? e.message : errorMessage(e);
    try {
      await this.end(false, msg);
    } catch (endErr) {
      this.notify(`${op} 失敗（終了の記録も失敗）`, errorMessage(endErr));
    }
    this.notify(`${op} 失敗`, msg);
    if (e instanceof StepFailed || e instanceof S.Rejected || e instanceof Interrupted) throw e;
    throw new StepFailed(errorMessage(e).slice(0, 300));
  }

  // ------------------------------------------------------------------ start
  async start(i: Inputs): Promise<{ mode: S.Mode } | DryRunReport> {
    if (i.dryRun === true) return this.dryRun("start", i);
    const kind = await this.begin("start", i);
    try {
      const repairOnly = kind === "repair" && this.state.mode === "NORMAL";
      if (!repairOnly) {
        await this.step("S1_mode_starting", () => this.setModeStep("STARTING", "NORMAL", i));
        await this.step("S2_beacon_starting", () => this.writeBeacon("STARTING"));
      }
      await this.step("S3_db_up", () => this.dbUp());
      await this.step("S4_db_validate", () => this.dbValidate(i));
      await this.step("S6_ingest_open", () => this.open("jra-bot-ingest", false));
      await this.step("S7_dashboard_open", () => this.open("jra-bot-dashboard", true));
      await this.step("S8_health", () => this.health());
      await this.step("S9_scheduler_resume", async () => {
        for (const j of SCHEDULER_JOBS) await this.gcp.schedulerResume(j);
        return "resumed";
      });
      if (!repairOnly) {
        await this.step("S10_mode_normal", () => this.setModeStep("NORMAL", "NORMAL", i));
        await this.step("S11_beacon_normal", () => this.writeBeacon("NORMAL"));
      } else {
        await this.repairBeacon("NORMAL");
      }
      this.checkAbort();
    } catch (e) {
      return this.fail("ops-start", e);
    }
    await this.end(true, null);
    return { mode: this.state.mode };
  }

  /** 修復モードでも、ビーコンが mode・署名鍵の kid と食い違っていれば署名し直す。 */
  private async repairBeacon(mode: S.Mode): Promise<void> {
    const b = this.state.beacon;
    if (b?.mode !== mode || b.kid !== this.kid) await this.step("S_beacon_repair", () => this.writeBeacon(mode));
  }

  private async setModeStep(mode: S.Mode, desired: S.Mode, i: Inputs): Promise<string> {
    await this.commit(S.setMode(this.state, mode, desired, i.actor, i.reason, this.clock.now()), `mode-${mode}`);
    return mode;
  }

  private async dbUp(): Promise<string> {
    const st = await this.gcp.sqlState();
    if (st.state === "RUNNABLE" && st.activationPolicy === "ALWAYS") return "already running";
    await this.gcp.sqlSetActivation("ALWAYS");
    for (let waited = 0; waited <= DB_START_TIMEOUT_S; waited += DB_POLL_S) {
      if ((await this.gcp.sqlState()).state === "RUNNABLE") return `RUNNABLE after ${waited}s`;
      await this.clock.sleep(DB_POLL_S, this.signal);
    }
    throw new StepFailed("Cloud SQL が RUNNABLE にならなかった（20 分）。再実行で続行できる");
  }

  private async dbValidate(i: Inputs): Promise<string> {
    const code = await this.gcp.runJob(DB_JOB, ["--mode=validate"]);
    if (code === 0) return "schema ok";
    if (code === 10) {
      if (i.applyPendingMigrations !== true) {
        throw new StepFailed(
          "未適用のマイグレーションがある（終了コード 10）。通常の適用は deploy の責務。apply_pending_migrations=true で再実行すると適用する",
        );
      }
      const m = await this.gcp.runJob(DB_JOB, ["--mode=migrate"]);
      if (m !== 0) throw new StepFailed(`migrate が失敗した（終了コード ${m}）`);
      return "migrated";
    }
    throw new StepFailed(`スキーマ検証が失敗（終了コード ${code}: 1=不整合・失敗版、75=DB 不達）`);
  }

  private async open(name: string, requireIap: boolean): Promise<string> {
    if (requireIap) {
      const st = await this.gcp.serviceState(name);
      if (!st.iapEnabled || st.iapMembers < 1) {
        throw new StepFailed("dashboard の IAP が無効、または許可リストが空。ingress を開けない（認証が緩む経路を作らない）");
      }
    }
    if ((await this.gcp.serviceState(name)).ingress !== "all") await this.gcp.serviceSetIngress(name, "all");
    return "ingress=all";
  }

  private async health(): Promise<string> {
    const bad: string[] = [];
    for (const name of SERVICES) {
      const code = await this.gcp.serviceHealth(name, "/internal/ready");
      if (code !== 200) bad.push(`${name}=${code}`);
    }
    if (bad.length > 0) throw new StepFailed(`ヘルスチェックに失敗: ${bad.join(", ")}`);
    return "ready";
  }

  // ------------------------------------------------------------------ stop
  async stop(i: Inputs): Promise<{ mode: S.Mode } | DryRunReport> {
    if (i.dryRun === true) return this.dryRun("stop", i);
    const kind = await this.begin("stop", i);
    try {
      const repairOnly = kind === "repair" && this.state.mode === "STOPPED";
      if (!repairOnly) {
        await this.step("S1_mode_stopping", () => this.setModeStep("STOPPING", "STOPPED", i));
        await this.step("S2_beacon_stopping", () => this.writeBeacon("STOPPING"));
      }
      await this.step("S3_scheduler_pause", async () => {
        for (const j of SCHEDULER_JOBS) await this.gcp.schedulerPause(j);
        return "paused";
      });
      await this.step("S5_drain", () => this.drain(i));
      await this.step("S6_cancel_rest", () => this.cancelRest());
      await this.step("S7_ingress_internal", () => this.close());
      await this.step("S8_verify_quiet", () => this.verifyQuiet());
      if (i.takeBackup === true) {
        await this.step("S9_backup", async () => {
          await this.gcp.sqlBackup();
          return "backup requested";
        });
      }
      await this.step("S10_db_stop", () => this.dbStop());
      if (!repairOnly) {
        await this.step("S11_mode_stopped", () => this.setModeStep("STOPPED", "STOPPED", i));
        await this.step("S12_beacon_stopped", () => this.writeBeacon("STOPPED"));
      } else {
        await this.repairBeacon("STOPPED");
      }
      this.checkAbort();
    } catch (e) {
      return this.fail("ops-stop", e);
    }
    await this.end(true, null);
    return { mode: this.state.mode };
  }

  private async drain(i: Inputs): Promise<string> {
    const limit = (i.drainTimeoutMin ?? 15) * 60;
    let waited = 0;
    while ((await this.gcp.runningExecutions()).length > 0) {
      if (waited >= limit) return `timeout after ${waited}s; remaining will be cancelled`;
      await this.clock.sleep(DRAIN_POLL_S, this.signal);
      waited += DRAIN_POLL_S;
    }
    return `drained after ${waited}s`;
  }

  private async cancelRest(): Promise<string> {
    let n = 0;
    for (const ex of await this.gcp.runningExecutions()) {
      await this.gcp.cancelExecution(ex);
      n++;
    }
    // 取消し後に 0 件でなければ DB を止めない
    for (let k = 0; k < 6; k++) {
      if ((await this.gcp.runningExecutions()).length === 0) return `cancelled ${n}`;
      await this.clock.sleep(10, this.signal);
    }
    throw new StepFailed("実行中の Job が残っている。DB を止めない。手動で cancel して stop を再実行");
  }

  private async close(): Promise<string> {
    for (const name of SERVICES) {
      if ((await this.gcp.serviceState(name)).ingress !== "internal") await this.gcp.serviceSetIngress(name, "internal"); // IAP・IAM には触れない
    }
    return "ingress=internal";
  }

  private async verifyQuiet(): Promise<string> {
    for (const name of SERVICES) {
      if ((await this.gcp.serviceState(name)).ingress !== "internal") throw new StepFailed(`${name} の ingress が internal ではない`);
    }
    if ((await this.gcp.runningExecutions()).length > 0) throw new StepFailed("実行中の Job が残っている");
    for (const name of SERVICES) {
      if (await this.gcp.serviceReachableExternally(name))
        throw new StepFailed(`${name} に外部から到達できる（ingress=internal が効いていない）。DB を止めない`);
    }
    await this.clock.sleep(POST_DRAIN_WAIT_S, this.signal);
    if ((await this.gcp.runningExecutions()).length > 0) throw new StepFailed("待機中に Job が起動した。DB を止めない");
    return "quiet";
  }

  private async dbStop(): Promise<string> {
    // 再実行でも毎回、DB を止める直前に実状態を測り、足りなければここでやり直す（前のステップが記録上 DONE でも信用しない）
    if ((await this.gcp.runningExecutions()).length > 0) await this.cancelRest();
    await this.close();
    for (const name of SERVICES) {
      if (await this.gcp.serviceReachableExternally(name)) throw new StepFailed(`${name} に外部から到達できる。DB を止めない`);
    }
    if ((await this.gcp.sqlState()).state === "STOPPED") return "already stopped";
    this.checkAbort();
    await this.gcp.sqlSetActivation("NEVER");
    for (let waited = 0; waited <= DB_START_TIMEOUT_S; waited += DB_POLL_S) {
      if ((await this.gcp.sqlState()).state === "STOPPED") return `STOPPED after ${waited}s`;
      await this.clock.sleep(DB_POLL_S, this.signal);
    }
    throw new StepFailed("Cloud SQL が STOPPED にならなかった。stop を再実行");
  }
}
