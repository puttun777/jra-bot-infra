/**
 * EC2 の上の運用エージェント（`jrabot-host`）の判断。**純粋な関数だけ**（Docker・AWS に触れない。実行は hostctl.ts）。
 * 1 分ごとの定期実行で、S3 の運用状態（mode・workloads）と手元の事実（コンテナ・spool・前回の結果）から、次に行うことを決める。
 *
 * - STARTING・NORMAL: 基本のサービス（MySQL・dashboard・リバースプロキシ・認証プロキシ）を動かす。開催日（raceday）のときだけ ingest と
 *   開催日の処理（calendar-check の定期実行 → spool の起動依頼で bot-run）を動かす。**閲覧（VIEW）だけの起動では ingest も bot も動かさない**。
 * - batch が許されていないのに重い処理が動いていれば止める（開催日が優先。メモリ）。raceday でないのに bot-run が動いていれば止める（安全に排出）。
 * - STOPPING・STOPPED（ホストが動いている）: 排出する（新規の受付停止 → 実行中の処理の終了 → 予定の書出し → バックアップ → 停止 → 電源断）。
 * - 運用状態を読めない（UNKNOWN）: 新しい処理を始めない・何も止めない（読めない間に誤って止めない）。開催日の処理は次の実行で再判断。
 */
import { z } from "zod";

export const BASE_SERVICES = ["mysql", "dashboard", "oauth2-proxy", "caddy"] as const;
export const RACEDAY_SERVICES = ["ingest"] as const;
export type Service = (typeof BASE_SERVICES)[number] | (typeof RACEDAY_SERVICES)[number];

/** calendar-check の理由のうち「その日の開催日の処理は終わった（これ以上 bot-run を起動しない）」もの（web の CalendarCheckReason）。 */
export const DAY_DONE_REASONS = new Set([
  "AFTER_SETTLE_DEADLINE",
  "ALREADY_COMPLETED",
  "NOT_A_RACE_DAY",
  "DAY_CANCELLED",
  "DAY_POSTPONED",
  "NEEDS_RECONCILE",
  "DENIED_BY_OVERRIDE",
]);

/** spool の起動依頼（web の SpoolJobLauncher。D-283）。ホストは bot-run だけを、決まった引数でだけ起動する。 */
export const SpoolRequestSchema = z
  .object({
    schema_version: z.literal(1),
    job: z.literal("bot-run"),
    tenant_id: z.literal(1),
    params: z
      .object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        trigger: z.enum(["SCHEDULER", "MANUAL", "RECONCILE", "BACKFILL"]).optional(),
      })
      .strict(),
    requested_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/),
  })
  .strict();
export type SpoolRequest = z.infer<typeof SpoolRequestSchema>;

export interface HostFacts {
  readonly now: string;
  /** S3 の運用状態（読めなければ undefined）。 */
  readonly ops:
    | {
        readonly seq: number;
        readonly mode: "NORMAL" | "STARTING" | "STOPPING" | "STOPPED";
        readonly raceday: boolean;
        readonly batch: boolean;
      }
    | undefined;
  readonly services: Readonly<Record<string, "running" | "stopped">>;
  readonly botRun: { readonly running: boolean; readonly date: string | null };
  readonly batch: { readonly running: boolean; readonly job: string | null };
  /** 前回の calendar-check の時刻と理由（今日の JST の日付のもの）。 */
  readonly lastCalendar: { readonly at: string; readonly reason: string; readonly date: string } | undefined;
  readonly spool: readonly { readonly file: string; readonly request: SpoolRequest | undefined }[];
  readonly racedayDone: readonly string[];
  readonly drained: boolean;
  /** 起動時の準備（秘密・DB の利用者・スキーマの確認）が終わったか。 */
  readonly prepared: boolean;
}

export type HostAction =
  | { readonly type: "up"; readonly services: readonly Service[] }
  | { readonly type: "stop"; readonly services: readonly Service[] }
  | { readonly type: "stop-job"; readonly job: "bot-run" | "batch" }
  | { readonly type: "calendar-check" }
  | { readonly type: "launch-bot-run"; readonly file: string; readonly date: string; readonly trigger: string }
  | { readonly type: "discard-spool"; readonly file: string; readonly reason: string }
  | { readonly type: "finish-raceday"; readonly date: string }
  | { readonly type: "drain" };

export interface HostConfig {
  /** calendar-check の間隔（秒）。 */
  readonly calendarIntervalSeconds: number;
}

const jstDate = (t: number): string => new Date(t + 9 * 3600_000).toISOString().slice(0, 10);

export function planHost(f: HostFacts, cfg: HostConfig): HostAction[] {
  const now = Date.parse(f.now);
  const today = jstDate(now);
  const out: HostAction[] = [];
  if (f.ops === undefined) return out; // 読めない間は何もしない（誤って止めない・新しい処理を始めない）
  if (f.ops.mode === "STOPPING" || f.ops.mode === "STOPPED") {
    if (!f.drained) out.push({ type: "drain" });
    return out;
  }
  if (!f.prepared) return out; // 起動の準備（秘密・DB・スキーマ）が終わるまでアプリを動かさない
  const running = (s: string): boolean => f.services[s] === "running";
  const raceday = f.ops.raceday && f.ops.mode === "NORMAL";
  // 基本のサービス
  const baseDown = BASE_SERVICES.filter((s) => !running(s));
  if (baseDown.length > 0) out.push({ type: "up", services: baseDown });
  // 開催日のサービス（ingest）。閲覧だけのときは止める
  if (f.ops.raceday && !running("ingest")) out.push({ type: "up", services: ["ingest"] });
  if (!f.ops.raceday && running("ingest")) out.push({ type: "stop", services: ["ingest"] });
  // 許されていない処理は止める（開催日でないのに bot-run、batch でないのに重い処理）
  if (!f.ops.raceday && f.botRun.running) out.push({ type: "stop-job", job: "bot-run" });
  if (!f.ops.batch && f.batch.running) out.push({ type: "stop-job", job: "batch" });
  // spool の起動依頼（bot-run だけ。1 回の実行で起動は 1 つまで: 2 つ目の起動が 1 つ目を消さないように。残りは次の実行で判断）
  let launched = false;
  for (const e of f.spool) {
    if (e.request === undefined) {
      out.push({ type: "discard-spool", file: e.file, reason: "形式が不正" });
      continue;
    }
    const date = e.request.params.date ?? today;
    if (!raceday) out.push({ type: "discard-spool", file: e.file, reason: "開催日の処理が許されていない" });
    else if (date !== today) out.push({ type: "discard-spool", file: e.file, reason: "今日の開催日ではない" });
    else if (f.botRun.running) out.push({ type: "discard-spool", file: e.file, reason: "bot-run は実行中（リースが二重起動を防ぐ）" });
    else if (!launched) {
      out.push({ type: "launch-bot-run", file: e.file, date, trigger: e.request.params.trigger ?? "SCHEDULER" });
      launched = true;
    }
  }
  if (!raceday || f.racedayDone.includes(today)) return out;
  // 開催日の定期の判断（calendar-check）。今日の結果が「終わった」で bot-run も動いていなければ後処理（照合・予定の書出し）
  const last = f.lastCalendar?.date === today ? f.lastCalendar : undefined;
  if (last !== undefined && DAY_DONE_REASONS.has(last.reason) && !f.botRun.running) {
    out.push({ type: "finish-raceday", date: today });
    return out;
  }
  const due = last === undefined || now - Date.parse(last.at) >= cfg.calendarIntervalSeconds * 1000;
  if (due && running("mysql")) out.push({ type: "calendar-check" });
  return out;
}

/** `JOB_RESULT task=calendar-check tenant=1 exit=0 reason=AFTER_SETTLE_DEADLINE` の行から理由（固定語彙）を取り出す。無ければ undefined。 */
export function parseJobResult(log: string, task: string): { exit: number; reason: string } | undefined {
  let found: { exit: number; reason: string } | undefined;
  const re = new RegExp(`JOB_RESULT task=${task.replace(/[-]/g, "\\-")} tenant=\\d+ exit=(\\d+) reason=([A-Z][A-Z0-9_]{0,63})`, "g");
  for (const m of log.matchAll(re)) found = { exit: Number(m[1]), reason: String(m[2]) };
  return found;
}

/**
 * mysqldump の引数（hostctl のバックアップと、結合試験 ops/it/backup-restore.mjs が同じものを使う）。
 * --single-transaction: InnoDB の一貫したスナップショット（書込みを止めない）。--set-gtid-purged=OFF: 別のサーバへ戻せる。
 * --databases: CREATE DATABASE と USE を含める（戻す先で同じ名前のスキーマに入る）。最後の行の `-- Dump completed` で途中切れを検出する。
 */
export const MYSQLDUMP_ARGS = [
  "--single-transaction",
  "--quick",
  "--routines",
  "--triggers",
  "--events",
  "--set-gtid-purged=OFF",
  "--hex-blob",
  "--default-character-set=utf8mb4",
  "--databases",
  "jrabot",
] as const;
