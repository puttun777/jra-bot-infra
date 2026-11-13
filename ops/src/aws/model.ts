/**
 * AWS 構成の運用状態（S3 の `state/ops-state.json`）と、ホスト・計画の文書の型（web CONTRACTS §5.2・§5.6、infra I-042）。
 * 外部入力（S3 から読んだ JSON・Lambda への要求）はすべて zod で実行時に検査する。未知のフィールドは保持する（前方互換）。
 *
 * 用語:
 * - **hold**: 「EC2 を動かしておく理由」1 件。目的（VIEW・RACEDAY・BATCH・MAINTENANCE）と期限を持つ。有効な hold が 1 つでもあれば動かし、
 *   無くなったら止める。自動停止は「予約された停止イベント」ではなく hold の期限で決まるので、古い停止イベントで誤って止まることがない。
 * - **workloads**: 有効な hold から導く「許された処理」（アプリ側の柵。web D-282）。raceday は RACEDAY の hold があるとき、
 *   batch は BATCH の hold があり RACEDAY の hold が無いとき（開催日の処理が優先。メモリ）。
 * - **mode**: 既存の運用モード（NORMAL / STARTING / STOPPING / STOPPED）。EC2 の状態とは別に、制御が決めた段階を表す。
 */
import { z } from "zod";
import { OpsStateSchema } from "../state.js";

export const PURPOSES = ["VIEW", "RACEDAY", "BATCH", "MAINTENANCE"] as const;
export type Purpose = (typeof PURPOSES)[number];

const ts = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "UTC の ISO 8601（秒、Z）");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const shortText = z.string().max(300);

export const HoldSchema = z.looseObject({
  id: z.string().regex(/^[a-z0-9-]{4,64}$/),
  purpose: z.enum(PURPOSES),
  created_at: ts,
  /** 最後に作成・延長した時刻（古い停止要求の判定に使う: 要求の時刻より後に延長された hold は解放しない）。 */
  updated_at: ts,
  expires_at: ts,
  actor: z.string().max(100),
  reason: shortText,
  /** RACEDAY のときの開催日（JST）。 */
  race_date: date.optional(),
});
export type Hold = z.infer<typeof HoldSchema>;

export const WorkloadsSchema = z.object({ raceday: z.boolean(), batch: z.boolean() }).strict();
export type Workloads = z.infer<typeof WorkloadsSchema>;

export const ManualRacedaySchema = z.looseObject({
  date,
  /** 最初・最後の発走（UTC）。分からなければ null（既定の時刻を使う）。 */
  first_post: ts.nullable(),
  last_post: ts.nullable(),
  added_by: z.string().max(100),
  added_at: ts,
});

export const AwsSectionSchema = z.looseObject({
  holds: z.array(HoldSchema).max(20).default([]),
  /** STARTING に入った時刻（起動の待ち時間の判定）。 */
  start_requested_at: ts.nullable().default(null),
  /** STOPPING に入った時刻（排出の待ち時間・強制停止の判定）。 */
  stop_requested_at: ts.nullable().default(null),
  /** 排出が終わらず StopInstances を出した時刻（さらに待って強制停止）。 */
  stop_issued_at: ts.nullable().default(null),
  /** 連続稼働の開始（NORMAL になった時刻。停止し忘れの上限の判定）。 */
  running_since: ts.nullable().default(null),
  completed_racedays: z.array(date).max(60).default([]),
  skip_dates: z.array(date).max(60).default([]),
  manual_racedays: z.array(ManualRacedaySchema).max(30).default([]),
  last_dns: z.looseObject({ ip: z.string(), at: ts }).nullable().default(null),
  last_stop: z
    .looseObject({ at: ts, clean: z.boolean(), backup_ok: z.boolean().nullable(), forced: z.boolean(), reason: shortText })
    .nullable()
    .default(null),
  /** 一度だけ通知した警告（同じ警告を毎回送らない）。 */
  alerted: z.array(z.string().max(120)).max(20).default([]),
});
export type AwsSection = z.infer<typeof AwsSectionSchema>;

export const AwsOpsStateSchema = OpsStateSchema.extend({
  workloads: WorkloadsSchema,
  aws: AwsSectionSchema,
});
export type AwsOpsState = z.infer<typeof AwsOpsStateSchema>;

/** ホストの運用エージェントが S3 の `status/host.json` に書く報告（infra の hostctl）。秘密・業務データを含めない。 */
export const HostStatusSchema = z.looseObject({
  schema_version: z.literal(1),
  instance_id: z.string().regex(/^i-[0-9a-f]{8,17}$/),
  boot_id: z.string().regex(/^[0-9a-f-]{8,64}$/),
  reported_at: ts,
  /** ホストが最後に読んで反映した ops-state の seq。 */
  seen_seq: z.number().int().min(0),
  phase: z.enum(["BOOTING", "READY", "DRAINING", "DRAINED"]),
  ready: z.looseObject({ mysql: z.boolean(), dashboard: z.boolean(), ingest: z.boolean() }),
  workloads_applied: WorkloadsSchema,
  bot_run: z.looseObject({ running: z.boolean(), date: date.nullable().default(null) }),
  batch: z.looseObject({ running: z.boolean(), job: z.string().max(40).nullable().default(null) }),
  /** 開催日の処理（bot-run・結果の照合）が終わった日（JST）。 */
  raceday_done: z.array(date).max(20).default([]),
  calendar: z.looseObject({ last_reason: z.string().max(64).nullable(), at: ts.nullable() }).optional(),
  backup: z
    .looseObject({
      last_ok_at: ts.nullable(),
      last_failed_at: ts.nullable(),
      last_key: z.string().max(300).nullable(),
      last_error: shortText.nullable(),
    })
    .optional(),
  release: z
    .looseObject({ app_release: z.string().max(40), git_sha: z.string().regex(/^[0-9a-f]{40}$/) })
    .nullable()
    .optional(),
  memory_mb: z.looseObject({ total: z.number(), available: z.number(), swap_used: z.number() }).optional(),
});
export type HostStatus = z.infer<typeof HostStatusSchema>;

/** web の `bot --task=calendar-plan` の出力（ホストが S3 の `control/calendar-plan.json` へ置く。web D-283）。 */
export const CalendarPlanSchema = z.looseObject({
  schema_version: z.literal(1),
  tenant_id: z.number().int().min(1),
  generated_at: ts,
  days: z
    .array(
      z.looseObject({
        date,
        verdict: z.enum(["CONFIRMED", "UNCONFIRMED", "STALE"]),
        first_post: ts.nullable(),
        last_post: ts.nullable(),
      }),
    )
    .max(60),
});
export type CalendarPlan = z.infer<typeof CalendarPlanSchema>;

/** EC2 の状態（DescribeInstances）。 */
export interface InstanceInfo {
  readonly state: "pending" | "running" | "stopping" | "stopped" | "shutting-down" | "terminated" | "unknown";
  readonly publicIp: string | undefined;
}

/** Lambda への要求（GitHub Actions の ops CLI・EventBridge Scheduler）。 */
export const RequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("tick") }).strict(),
  z.object({ action: z.literal("status") }).strict(),
  z
    .object({
      action: z.literal("view"),
      minutes: z.number().int().min(10).max(240),
      actor: z.string().min(1).max(100),
      reason: shortText.default("閲覧"),
    })
    .strict(),
  z.object({ action: z.literal("view-end"), actor: z.string().min(1).max(100), requested_at: ts }).strict(),
  z
    .object({
      action: z.literal("batch"),
      minutes: z.number().int().min(10).max(720),
      actor: z.string().min(1).max(100),
      reason: z.string().min(1).max(300),
    })
    .strict(),
  z
    .object({
      action: z.literal("maintenance"),
      minutes: z.number().int().min(10).max(180),
      actor: z.string().min(1).max(100),
      reason: z.string().min(1).max(300),
    })
    .strict(),
  z.object({ action: z.literal("release"), hold_id: z.string().regex(/^[a-z0-9-]{4,64}$/), actor: z.string().min(1).max(100) }).strict(),
  z
    .object({
      action: z.literal("raceday-add"),
      date,
      first_post: ts.nullable().default(null),
      last_post: ts.nullable().default(null),
      actor: z.string().min(1).max(100),
    })
    .strict(),
  z.object({ action: z.literal("raceday-skip"), date, actor: z.string().min(1).max(100), reason: z.string().min(1).max(300) }).strict(),
  z
    .object({
      action: z.literal("stop-all"),
      actor: z.string().min(1).max(100),
      reason: z.string().min(1).max(300),
      requested_at: ts,
    })
    .strict(),
]);
export type Request = z.infer<typeof RequestSchema>;

/** 制御の設定（Lambda の環境変数。Pulumi が渡す）。 */
export const ControllerConfigSchema = z.object({
  /** 最初の発走の何分前に開催日の起動を始めるか（エージェントがビーコンを確認する間隔 60 分 + 起動 + 余裕）。 */
  racedayLeadMinutes: z.number().int().min(60).max(720),
  /** 最後の発走の何分後まで開催日の hold を保つか（結果・払戻の取込と照合。アプリの CALENDAR_SETTLE_DEADLINE_MINUTES 以上）。 */
  racedayTailMinutes: z.number().int().min(30).max(600),
  /** 発走時刻が分からない日の既定（JST の HH:MM）。 */
  defaultFirstPostJst: z.string().regex(/^\d{2}:\d{2}$/),
  defaultLastPostJst: z.string().regex(/^\d{2}:\d{2}$/),
  /** 起動を要求してから準備完了まで待つ上限（超えたら警告。起動の要求は続ける）。 */
  startTimeoutMinutes: z.number().int().min(5).max(60),
  /** 排出（ホストの安全な停止）を待つ上限。超えたら StopInstances、さらに待って強制停止。 */
  drainTimeoutMinutes: z.number().int().min(5).max(60),
  forceStopAfterMinutes: z.number().int().min(5).max(60),
  /** 連続稼働の上限（停止し忘れの最後の安全網。超えたら hold を外して止める）。 */
  maxRunningHours: z.number().int().min(4).max(48),
  /** ホストの報告を新しいとみなす上限。 */
  hostFreshSeconds: z.number().int().min(60).max(900),
});
export type ControllerConfig = z.infer<typeof ControllerConfigSchema>;

export const DEFAULT_CONFIG: ControllerConfig = {
  racedayLeadMinutes: 240,
  racedayTailMinutes: 150,
  defaultFirstPostJst: "09:50",
  defaultLastPostJst: "16:40",
  startTimeoutMinutes: 20,
  drainTimeoutMinutes: 25,
  forceStopAfterMinutes: 10,
  maxRunningHours: 20,
  hostFreshSeconds: 240,
};
