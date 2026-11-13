/**
 * AWS の起動・停止の制御（Lambda）の判断。**純粋な関数だけ**（AWS に触れない）。入力は運用状態・ホストの報告・EC2 の状態・開催予定・時刻で、
 * 出力は次の運用状態と、実行すべき副作用（StartInstances・StopInstances・ビーコン・DNS・通知）。副作用はどれも冪等なので、
 * 5 分ごとの定期実行（EventBridge Scheduler）と要求のたびに「あるべき姿へ 1 歩近づける」だけでよい（収束型）。
 *
 * 安全の原則:
 * 1. 止める判断は「有効な hold が無い」ことだけで決まる。予約された停止イベントは無いので、古いイベント・延長との競合で誤って止まらない。
 * 2. 閲覧（VIEW）の期限切れは VIEW の hold を外すだけ。開催日（RACEDAY）・重い処理（BATCH）の hold があれば止まらない。
 * 3. 停止はまず STOPPING を書き（ホストが新規の処理を止め、実行中の処理を終え、バックアップしてから自分で電源を切る）、終わらなければ
 *    StopInstances、さらに待って強制停止。最後の安全網として連続稼働の上限で止める（停止し忘れの防止）。
 * 4. 起動の途中で要求が消えたら止める。停止の途中で新しい要求が来たら、停止を最後まで終えてから起動し直す（中途の状態を作らない）。
 * 5. EC2 の STOPPED と運用モードの STOPPED を混同しない: mode は制御が決めた段階で、EC2 の状態は別に読む。
 */
import type { Mode } from "../state.js";
import * as S from "../state.js";
import {
  type AwsOpsState,
  AwsSectionSchema,
  type CalendarPlan,
  type ControllerConfig,
  type Hold,
  type HostStatus,
  type InstanceInfo,
  type Purpose,
  type Request,
  type Workloads,
} from "./model.js";

export interface Effects {
  /** StartInstances（冪等。止まっているときだけ実際に起動する）。 */
  readonly start: boolean;
  /** StopInstances。force は強制停止（OS の停止を待たない）。 */
  readonly stop: "none" | "normal" | "force";
  /** ビーコンを書き直す（運用状態の beacon と食い違うとき）。 */
  readonly beacon: Mode | undefined;
  /** DNS の A レコードを書き直す（公開 IP が変わったとき）。 */
  readonly dnsIp: string | undefined;
  readonly notify: readonly { readonly title: string; readonly body: string }[];
}

export class RequestRejected extends Error {
  override readonly name = "RequestRejected";
}

const MIN = 60_000;
/** 動いている間に DNS を書き直す間隔（IP は変わらなくても、前回の書込みの失敗を直す）。Route 53 の変更の API は無料。 */
const DNS_REFRESH_MINUTES = 60;
/** 止まっている間の A レコードの向け先（文書用のアドレス。どこにも届かない）。手放した公開 IP を他人が拾っても、この名前の証明書を取らせない。 */
export const DNS_SINKHOLE = "192.0.2.1";
/** 手動の開催日・飛ばす日の上限（状態の検査の上限と同じ。超える要求は拒否して、状態を読めなくしない）。 */
const MAX_MANUAL_RACEDAYS = 30;
const MAX_SKIP_DATES = 60;
/** 開催の計画が古いとみなす日数（計画は動いている間だけ更新される）。 */
const PLAN_STALE_DAYS = 10;
const ms = (iso: string): number => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`日時が不正: ${iso}`);
  return t;
};
const iso = (t: number): string => S.isoSeconds(t);

/** JST（UTC+9。夏時間なし）の日付と HH:MM から UTC の時刻。 */
export function jstToUtcMs(dateYmd: string, hhmm: string): number {
  return ms(`${dateYmd}T${hhmm}:00Z`) - 9 * 60 * MIN;
}

/** UTC の時刻の JST の日付（YYYY-MM-DD）。 */
export function jstDate(t: number): string {
  return new Date(t + 9 * 60 * MIN).toISOString().slice(0, 10);
}

export function initialAwsState(now: string): AwsOpsState {
  const base = S.initialState(now);
  return { ...base, workloads: { raceday: false, batch: false }, aws: AwsSectionSchema.parse({}) };
}

export function activeHolds(state: AwsOpsState, now: number): Hold[] {
  return state.aws.holds.filter((h) => ms(h.expires_at) > now);
}

export function computeWorkloads(holds: readonly Hold[]): Workloads {
  const raceday = holds.some((h) => h.purpose === "RACEDAY");
  return { raceday, batch: !raceday && holds.some((h) => h.purpose === "BATCH") };
}

function clone(s: AwsOpsState): AwsOpsState {
  return structuredClone(s);
}

function holdId(purpose: Purpose, now: number): string {
  return `${purpose.toLowerCase()}-${new Date(now)
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14)}`;
}

/** 有効な RACEDAY の hold があるか（BATCH・MAINTENANCE の受付の判断）。 */
function racedayActive(state: AwsOpsState, now: number): boolean {
  return activeHolds(state, now).some((h) => h.purpose === "RACEDAY");
}

export interface RequestResult {
  readonly state: AwsOpsState;
  readonly message: string;
  readonly holdId?: string;
}

/**
 * 本人の要求を運用状態に反映する（副作用は reconcile が決める）。拒否は RequestRejected（状態は変えない）。
 * - view: VIEW の hold を作る。既にあれば期限を延ばす（短くはしない）。同じ id を返す（延長）。
 * - view-end: **要求の時刻より前に作成・延長された** VIEW の hold だけを外す（古い要求で、後から延長した閲覧を止めない）。
 * - batch: 開催日の処理中は受け付けない（メモリ。開催日が優先）。
 * - stop-all: 要求の時刻より前の hold をすべて外し、今日の開催日を再び自動で起動しない（skip）。理由が必須。
 */
export function applyRequest(state: AwsOpsState, req: Request, nowIso: string): RequestResult {
  const now = ms(nowIso);
  const s = clone(state);
  s.aws.holds = activeHolds(s, now);
  // 要求の時刻（本人が実行した時刻）。未来・1 時間より前は信用せず処理の時刻を使う
  const stamp = (requestedAt: string | undefined): string =>
    requestedAt !== undefined && ms(requestedAt) <= now && now - ms(requestedAt) <= 60 * MIN ? requestedAt : nowIso;
  const upsert = (purpose: Purpose, minutes: number, actor: string, reason: string, requestedAt?: string): RequestResult => {
    const until = now + minutes * MIN;
    const at = stamp(requestedAt);
    const existing = s.aws.holds.find((h) => h.purpose === purpose);
    if (existing !== undefined) {
      if (ms(existing.expires_at) < until) existing.expires_at = iso(until);
      if (ms(existing.updated_at) < ms(at)) existing.updated_at = at;
      existing.actor = actor;
      return { state: s, message: `${purpose} を延長（期限 ${existing.expires_at}）`, holdId: existing.id };
    }
    const h: Hold = { id: holdId(purpose, now), purpose, created_at: at, updated_at: at, expires_at: iso(until), actor, reason };
    s.aws.holds.push(h);
    return { state: s, message: `${purpose} を受付（期限 ${h.expires_at}）`, holdId: h.id };
  };
  switch (req.action) {
    case "tick":
    case "status":
      return { state: s, message: "" };
    case "view":
      return upsert("VIEW", req.minutes, req.actor, req.reason, req.requested_at);
    case "view-end": {
      const before = s.aws.holds.length;
      const cut = ms(req.requested_at);
      s.aws.holds = s.aws.holds.filter((h) => h.purpose !== "VIEW" || ms(h.updated_at) > cut);
      return { state: s, message: before === s.aws.holds.length ? "外す閲覧は無い（要求の後に延長された閲覧は残す）" : "閲覧を終了" };
    }
    case "batch":
      if (racedayActive(s, now)) throw new RequestRejected("開催日の処理中は重い処理を受け付けない（終わってから実行する）");
      return upsert("BATCH", req.minutes, req.actor, req.reason);
    case "maintenance":
      return upsert("MAINTENANCE", req.minutes, req.actor, req.reason);
    case "release": {
      const h = s.aws.holds.find((x) => x.id === req.hold_id);
      if (h === undefined) return { state: s, message: "その hold は既に無い" };
      if (h.purpose === "RACEDAY" && h.race_date !== undefined && !s.aws.skip_dates.includes(h.race_date))
        s.aws.skip_dates.push(h.race_date);
      s.aws.holds = s.aws.holds.filter((x) => x.id !== req.hold_id);
      return { state: s, message: `${h.purpose} を解放` };
    }
    case "raceday-add": {
      if (s.aws.manual_racedays.some((d) => d.date === req.date)) return { state: s, message: "既に登録済み" };
      if (req.date < jstDate(now - 24 * 60 * MIN) || req.date > jstDate(now + 90 * 24 * 60 * MIN))
        throw new RequestRejected("開催日は昨日から 90 日先までの日付にする");
      if (s.aws.manual_racedays.length >= MAX_MANUAL_RACEDAYS)
        throw new RequestRejected(`手動の開催日は ${MAX_MANUAL_RACEDAYS} 件まで（古いものは 14 日で消える）`);
      s.aws.manual_racedays.push({
        date: req.date,
        first_post: req.first_post,
        last_post: req.last_post,
        added_by: req.actor,
        added_at: nowIso,
      });
      s.aws.skip_dates = s.aws.skip_dates.filter((d) => d !== req.date);
      s.aws.completed_racedays = s.aws.completed_racedays.filter((d) => d !== req.date);
      return { state: s, message: `開催日 ${req.date} を手動で登録` };
    }
    case "raceday-skip": {
      if (req.date < jstDate(now - 24 * 60 * MIN) || req.date > jstDate(now + 90 * 24 * 60 * MIN))
        throw new RequestRejected("飛ばす日は昨日から 90 日先までの日付にする");
      if (!s.aws.skip_dates.includes(req.date) && s.aws.skip_dates.length >= MAX_SKIP_DATES)
        throw new RequestRejected(`飛ばす日は ${MAX_SKIP_DATES} 件まで`);
      if (!s.aws.skip_dates.includes(req.date)) s.aws.skip_dates.push(req.date);
      s.aws.holds = s.aws.holds.filter((h) => !(h.purpose === "RACEDAY" && h.race_date === req.date));
      return { state: s, message: `開催日 ${req.date} を自動起動しない` };
    }
    case "stop-all": {
      const cut = ms(req.requested_at);
      const today = jstDate(now);
      for (const h of s.aws.holds)
        if (h.purpose === "RACEDAY" && h.race_date !== undefined && ms(h.updated_at) <= cut && !s.aws.skip_dates.includes(h.race_date))
          s.aws.skip_dates.push(h.race_date);
      s.aws.holds = s.aws.holds.filter((h) => ms(h.updated_at) > cut);
      if (!s.aws.skip_dates.includes(today) && !s.aws.holds.some((h) => h.purpose === "RACEDAY")) s.aws.skip_dates.push(today);
      return { state: s, message: "すべての hold を外した（今日の開催日は自動で再起動しない）" };
    }
  }
}

/** 開催日の窓（UTC ミリ秒）。発走時刻が分からなければ既定の時刻。 */
export function racedayWindow(
  day: { date: string; first_post: string | null; last_post: string | null },
  cfg: ControllerConfig,
): { start: number; end: number } {
  const first = day.first_post === null ? jstToUtcMs(day.date, cfg.defaultFirstPostJst) : ms(day.first_post);
  const last = day.last_post === null ? jstToUtcMs(day.date, cfg.defaultLastPostJst) : ms(day.last_post);
  return { start: first - cfg.racedayLeadMinutes * MIN, end: Math.max(last, first) + cfg.racedayTailMinutes * MIN };
}

/** 開催予定（S3 の計画 + 手動の登録）から、今が窓の中の日の RACEDAY の hold を作る・期限を合わせる。終わった日・飛ばす日は外す。 */
export function syncRacedayHolds(
  state: AwsOpsState,
  plan: CalendarPlan | undefined,
  host: HostStatus | undefined,
  now: number,
  cfg: ControllerConfig,
): AwsOpsState {
  const s = clone(state);
  for (const d of host?.raceday_done ?? []) {
    // ホストが「終わった」と報告した日（その日の hold を作った後の報告だけを信じる）
    const h = s.aws.holds.find((x) => x.purpose === "RACEDAY" && x.race_date === d);
    if (h !== undefined && host !== undefined && ms(host.reported_at) >= ms(h.created_at)) {
      if (!s.aws.completed_racedays.includes(d)) s.aws.completed_racedays.push(d);
    }
  }
  s.aws.completed_racedays = s.aws.completed_racedays.slice(-60);
  const candidates = new Map<string, { date: string; first_post: string | null; last_post: string | null }>();
  for (const d of plan?.days ?? []) candidates.set(d.date, { date: d.date, first_post: d.first_post, last_post: d.last_post });
  for (const d of s.aws.manual_racedays) candidates.set(d.date, { date: d.date, first_post: d.first_post, last_post: d.last_post });
  const wanted = new Map<string, number>();
  for (const day of candidates.values()) {
    if (s.aws.skip_dates.includes(day.date) || s.aws.completed_racedays.includes(day.date)) continue;
    const w = racedayWindow(day, cfg);
    if (now >= w.start && now < w.end) wanted.set(day.date, w.end);
  }
  // 計画が読めない（無い・壊れている）ときは、動いている開催日の hold を期限まで保つ（計画の不具合で開催日の途中に止めない）
  if (plan === undefined)
    for (const h of s.aws.holds)
      if (
        h.purpose === "RACEDAY" &&
        h.race_date !== undefined &&
        !wanted.has(h.race_date) &&
        !s.aws.skip_dates.includes(h.race_date) &&
        !s.aws.completed_racedays.includes(h.race_date)
      )
        wanted.set(h.race_date, ms(h.expires_at));
  // 窓に入っていない・終わった・飛ばす日の RACEDAY の hold は外す（期限より前でも）
  s.aws.holds = s.aws.holds.filter((h) => h.purpose !== "RACEDAY" || (h.race_date !== undefined && wanted.has(h.race_date)));
  for (const [d, end] of wanted) {
    const h = s.aws.holds.find((x) => x.purpose === "RACEDAY" && x.race_date === d);
    if (h === undefined) {
      const nowIso = iso(now);
      s.aws.holds.push({
        id: `raceday-${d}`,
        purpose: "RACEDAY",
        created_at: nowIso,
        updated_at: nowIso,
        expires_at: iso(end),
        actor: "calendar",
        reason: `開催日 ${d}`,
        race_date: d,
      });
    } else if (h.expires_at !== iso(end)) {
      h.expires_at = iso(end);
    }
  }
  // 古い手動の登録・飛ばす日・完了の記録は 14 日で消す（状態を大きくしない）
  const keepAfter = jstDate(now - 14 * 24 * 60 * MIN);
  s.aws.manual_racedays = s.aws.manual_racedays.filter((d) => d.date >= keepAfter);
  s.aws.skip_dates = s.aws.skip_dates.filter((d) => d >= keepAfter);
  s.aws.completed_racedays = s.aws.completed_racedays.filter((d) => d >= keepAfter);
  return s;
}

function hostFresh(host: HostStatus | undefined, since: number, now: number, cfg: ControllerConfig): host is HostStatus {
  if (host === undefined) return false;
  const at = ms(host.reported_at);
  return at >= since && now - at <= cfg.hostFreshSeconds * 1000;
}

/** ビーコンの mode（エージェント向け: 送ってよいのは開催日の処理中に ingest が準備できたときだけ。web CONTRACTS §7.2 の AWS 版）。 */
export function beaconMode(state: AwsOpsState, host: HostStatus | undefined, now: number, cfg: ControllerConfig): Mode {
  if (state.mode !== "NORMAL") return state.mode;
  const fresh = hostFresh(host, 0, now, cfg);
  return state.workloads.raceday && fresh && host.ready.ingest && host.workloads_applied.raceday ? "NORMAL" : "STOPPED";
}

function alertOnce(s: AwsOpsState, key: string, title: string, body: string, out: { title: string; body: string }[]): void {
  if (s.aws.alerted.includes(key)) return;
  s.aws.alerted = [...s.aws.alerted, key].slice(-20);
  out.push({ title, body });
}

/**
 * 1 回分の収束。戻り値の state が入力と違えば CAS で書き、その後に副作用を実行する（副作用が失敗しても次の実行でやり直せる）。
 */
export function reconcile(
  input: AwsOpsState,
  host: HostStatus | undefined,
  instance: InstanceInfo,
  plan: CalendarPlan | undefined,
  nowIso: string,
  cfg: ControllerConfig,
  /** 公開中のビーコンの mode（読めなければ undefined = 書き直す）。書込みの失敗・取り違えを次の実行で直すため、記録ではなく実物と比べる。 */
  publishedBeacon: Mode | undefined,
): { state: AwsOpsState; effects: Effects } {
  const now = ms(nowIso);
  let s = syncRacedayHolds(input, plan, host, now, cfg);
  s.aws.holds = activeHolds(s, now);
  const notify: { title: string; body: string }[] = [];
  let start = false;
  let stop: Effects["stop"] = "none";

  // 最後の安全網: 連続稼働の上限（停止し忘れ）。hold を外して止める
  // 開催日の hold がある間は適用しない（開催日の窓は計画で上限がある。前夜からの batch などで開催日の途中に止めない）
  if (
    s.aws.running_since !== null &&
    now - ms(s.aws.running_since) > cfg.maxRunningHours * 60 * MIN &&
    s.aws.holds.length > 0 &&
    !s.aws.holds.some((h) => h.purpose === "RACEDAY")
  ) {
    alertOnce(
      s,
      `max-running-${s.aws.running_since}`,
      "連続稼働の上限で停止",
      `${cfg.maxRunningHours} 時間を超えたため hold を外して停止する`,
      notify,
    );
    for (const h of s.aws.holds)
      if (h.purpose === "RACEDAY" && h.race_date !== undefined && !s.aws.skip_dates.includes(h.race_date))
        s.aws.skip_dates.push(h.race_date);
    s.aws.holds = [];
  }
  const want = s.aws.holds.length > 0;
  const workloads = computeWorkloads(s.aws.holds);
  const running = instance.state === "running" || instance.state === "pending";

  switch (s.mode) {
    case "STOPPED": {
      if (want) {
        s = S.setMode(s, "STARTING", "NORMAL", "controller", "hold あり", nowIso) as AwsOpsState;
        s.aws.start_requested_at = nowIso;
        s.aws.stop_requested_at = null;
        s.aws.stop_issued_at = null;
        start = true;
      } else if (running) {
        // 制御を通さずに起動された（手動・誤操作）。停止の手順で止める（ホストは STOPPING を見て安全に停止する）
        s = S.setMode(s, "STOPPING", "STOPPED", "controller", "制御を通さない起動", nowIso) as AwsOpsState;
        s.aws.stop_requested_at = nowIso;
        alertOnce(
          s,
          `unexpected-run-${nowIso.slice(0, 13)}`,
          "制御を通さない起動を検知",
          "STOPPED のまま EC2 が動いていたので停止する",
          notify,
        );
      }
      break;
    }
    case "STARTING": {
      if (!want) {
        s = S.setMode(s, "STOPPING", "STOPPED", "controller", "起動中に hold が無くなった", nowIso) as AwsOpsState;
        s.aws.stop_requested_at = nowIso;
        break;
      }
      if (!running) start = true; // 冪等（止まっていれば起動、停止中なら次の実行で）
      const since = ms(s.aws.start_requested_at ?? nowIso);
      if (
        running &&
        hostFresh(host, since, now, cfg) &&
        host.phase === "READY" &&
        host.ready.mysql &&
        host.ready.dashboard &&
        host.seen_seq >= input.seq
      ) {
        s = S.setMode(s, "NORMAL", "NORMAL", "controller", "ホストの準備完了", nowIso) as AwsOpsState;
        s.aws.running_since = s.aws.running_since ?? nowIso;
        s.aws.alerted = s.aws.alerted.filter((a) => !a.startsWith("start-timeout"));
      } else if (now - since > cfg.startTimeoutMinutes * MIN) {
        alertOnce(
          s,
          `start-timeout-${s.aws.start_requested_at}`,
          "起動が完了しない",
          `${cfg.startTimeoutMinutes} 分を超えた（EC2=${instance.state}）。起動の要求は続ける`,
          notify,
        );
      }
      break;
    }
    case "NORMAL": {
      if (!want) {
        s = S.setMode(s, "STOPPING", "STOPPED", "controller", "hold が無い（期限切れ・解放）", nowIso) as AwsOpsState;
        s.aws.stop_requested_at = nowIso;
        break;
      }
      if (!running && (instance.state === "stopped" || instance.state === "stopping")) {
        // 予期しない停止（ホストの障害・手動の停止）。hold があるので起動し直す
        s = S.setMode(s, "STARTING", "NORMAL", "controller", "予期しない停止からの復帰", nowIso) as AwsOpsState;
        s.aws.start_requested_at = nowIso;
        s.aws.running_since = null;
        start = instance.state === "stopped";
        alertOnce(
          s,
          `unexpected-stop-${nowIso.slice(0, 13)}`,
          "予期しない停止",
          "hold があるのに EC2 が止まっていたので起動し直す",
          notify,
        );
      }
      break;
    }
    case "STOPPING": {
      const since = ms(s.aws.stop_requested_at ?? nowIso);
      if (instance.state === "stopped" || instance.state === "terminated") {
        const clean = host !== undefined && host.phase === "DRAINED" && ms(host.reported_at) >= since;
        const backupOk = clean
          ? host.backup?.last_ok_at !== null && host.backup?.last_ok_at !== undefined && ms(host.backup.last_ok_at) >= since
          : null;
        s.aws.last_stop = { at: nowIso, clean, backup_ok: backupOk, forced: s.aws.stop_issued_at !== null, reason: s.desired.reason ?? "" };
        s = S.setMode(s, "STOPPED", "STOPPED", "controller", "EC2 が停止した", nowIso) as AwsOpsState;
        s.aws.stop_requested_at = null;
        s.aws.stop_issued_at = null;
        s.aws.running_since = null;
        if (!clean)
          notify.push({
            title: "停止の手順が完了していない",
            body: "ホストの排出・バックアップの完了を確認できないまま停止した（データは EBS に残る）。次の起動後に status とバックアップを確認する",
          });
        else if (backupOk === false)
          notify.push({ title: "停止時のバックアップが失敗", body: "EBS のデータは残っている。status の backup を確認する" });
        break;
      }
      if (instance.state === "stopping" || instance.state === "shutting-down") {
        // 止まりかけのまま動かない（ハードウェアの障害など）。排出と停止の猶予を合わせて超えたら強制停止
        if (now - since > (cfg.drainTimeoutMinutes + cfg.forceStopAfterMinutes) * MIN) {
          stop = "force";
          s.aws.stop_issued_at = s.aws.stop_issued_at ?? nowIso;
          alertOnce(s, `stuck-stopping-${s.aws.stop_requested_at}`, "停止が終わらない", "stopping のまま動かないので強制停止する", notify);
        }
        break;
      }
      if (s.aws.stop_issued_at === null && now - since > cfg.drainTimeoutMinutes * MIN) {
        s.aws.stop_issued_at = nowIso;
        stop = "normal";
        alertOnce(
          s,
          `drain-timeout-${s.aws.stop_requested_at}`,
          "排出が終わらないので停止を指示",
          `${cfg.drainTimeoutMinutes} 分を超えた`,
          notify,
        );
      } else if (s.aws.stop_issued_at !== null) {
        const issued = ms(s.aws.stop_issued_at);
        stop = now - issued > cfg.forceStopAfterMinutes * MIN ? "force" : "normal";
        if (stop === "force")
          alertOnce(s, `force-stop-${s.aws.stop_issued_at}`, "強制停止", "通常の停止で止まらないので強制停止する", notify);
      }
      break;
    }
  }

  // workloads は NORMAL・STARTING のときだけ有効（停止中は何も許さない）
  s.workloads = s.mode === "NORMAL" || s.mode === "STARTING" ? workloads : { raceday: false, batch: false };
  const beacon = beaconMode(s, host, now, cfg);
  // DNS: IP が変わったとき（起動のたびに変わる）と、念のため 1 時間ごとに書き直す（前回の書込みの失敗を自然に直す）。記録は状態と一緒に CAS で書く
  // 止まっている間は文書用のアドレスに向ける（手放した公開 IP を他人が拾っても、この名前に届かない・証明書を取らせない）
  const dnsTarget = running ? instance.publicIp : instance.state === "stopped" ? DNS_SINKHOLE : undefined;
  const dnsStale = s.aws.last_dns === null || s.aws.last_dns.ip !== dnsTarget || now - ms(s.aws.last_dns.at) > DNS_REFRESH_MINUTES * MIN;
  const dnsIp = dnsTarget !== undefined && dnsStale ? dnsTarget : undefined;
  if (dnsIp !== undefined) s.aws.last_dns = { ip: dnsIp, at: nowIso };
  // 開催の計画が無い・古い（動いている間だけ更新される）: 開催日に自動で起動できないので知らせる（1 日 1 回）
  if (plan === undefined || now - ms(plan.generated_at) > PLAN_STALE_DAYS * 24 * 60 * MIN)
    alertOnce(
      s,
      `plan-${jstDate(now)}`,
      "開催の計画が無い・古い",
      "開催日の自動起動ができない。aws-view で一度起動する（計画を更新する）か、aws-raceday add で登録する",
      notify,
    );
  return { state: s, effects: { start, stop, beacon: publishedBeacon === beacon ? undefined : beacon, dnsIp, notify } };
}

/** 本人向けの状態の要約（status の出力・workflow の表示）。秘密は含まない。 */
export function summarize(
  state: AwsOpsState,
  host: HostStatus | undefined,
  instance: InstanceInfo,
  nowIso: string,
  url: string | undefined,
): Record<string, unknown> {
  const now = ms(nowIso);
  const holds = activeHolds(state, now);
  const ready = state.mode === "NORMAL" && host !== undefined && host.phase === "READY";
  return {
    now: nowIso,
    mode: state.mode,
    ec2: instance.state,
    usable: ready,
    url: ready ? (url ?? null) : null,
    workloads: state.workloads,
    holds: holds.map((h) => ({ id: h.id, purpose: h.purpose, expires_at: h.expires_at, race_date: h.race_date ?? null })),
    auto_stop_at:
      holds.length === 0
        ? null
        : holds
            .map((h) => h.expires_at)
            .sort()
            .at(-1),
    host:
      host === undefined
        ? null
        : {
            reported_at: host.reported_at,
            phase: host.phase,
            ready: host.ready,
            bot_run: host.bot_run,
            batch: host.batch,
            backup: host.backup ?? null,
            release: host.release ?? null,
          },
    last_stop: state.aws.last_stop,
    beacon: state.beacon ?? null,
    seq: state.seq,
  };
}
