// スタックの設定（Terraform の variables.tf と同じ項目・同じ検証）。外部入力なので zod で実行時に検査し、失敗したら定義を作らない。
import { z } from "zod";

const DIGEST_REF = /^[a-z0-9-]+-docker\.pkg\.dev\/[a-z0-9.:-]+\/[a-z0-9._-]+\/[a-z0-9._-]+@sha256:[0-9a-f]{64}$/;

/** app_runtime に必須の運用値（CONTRACTS §2。CALENDAR_* / BOT_RUN_*）。既定値は無い。 */
export const REQUIRED_RUNTIME_KEYS = [
  "CALENDAR_WATCH_START_MINUTES",
  "CALENDAR_PRESTART_MINUTES",
  "CALENDAR_SETTLE_DEADLINE_MINUTES",
  "CALENDAR_STALE_AFTER_MINUTES",
  "BOT_RUN_LEASE_SECONDS",
  "BOT_RUN_HEARTBEAT_SECONDS",
  "BOT_RUN_POLL_FAR_SECONDS",
  "BOT_RUN_POLL_MID_SECONDS",
  "BOT_RUN_POLL_NEAR_SECONDS",
  "BOT_RUN_MAX_ODDS_AGE_SECONDS",
  "BOT_RUN_MAX_RUNTIME_MINUTES",
  "BOT_RUN_STALE_CLAIM_SECONDS",
  "BOT_RUN_MAX_CYCLE_FAILURES",
  "BOT_RUN_SNAPSHOT_MINUTES",
  "BOT_RUN_TIGHTEN_NEAR",
  "BOT_RUN_SNAPSHOT_HISTORY_LIMIT",
  "BOT_RUN_RESULT_AFTER_MINUTES",
  "BOT_RUN_RESULT_POLL_SECONDS",
  "BOT_RUN_ML_MODEL_TYPE",
  "BOT_RUN_DECISION_PROFILE",
] as const;

const digest = z.string().regex(DIGEST_REF, "イメージは <registry>/<project>/<repo>/<name>@sha256:<64桁> の digest 参照（タグ不可）");

export const ReleaseImages = z.object({ dashboard: digest, ingest: digest, bot: digest, db_migration: digest, ml_train: digest }).strict();
export type ReleaseImages = z.infer<typeof ReleaseImages>;

const email = z.string().regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "メールアドレスの形式");

export const InfraConfig = z
  .object({
    projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, "プロジェクト ID の形式"),
    projectNumber: z.string().regex(/^[0-9]{6,20}$/, "プロジェクト番号は数字"),
    region: z
      .string()
      .regex(/^[a-z]+-[a-z]+[0-9]$/)
      .default("asia-northeast1"),
    githubRepoInfra: z
      .string()
      .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/)
      .default("puttun777/jra-bot-infra"),
    githubRepoWeb: z
      .string()
      .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/)
      .default("puttun777/jra-bot-web"),
    allowedUsers: z.array(email).default([]),
    adminUsers: z.array(email).default([]),
    tenantId: z.number().int().positive().default(1),
    // 共有コアの最小（0.6 GiB）。費用の最小化（本人の選択: web D-278・HOSTING_OPTIONS 案 1）。MySQL 8.4 で選べるか・接続数は G-DB-1 で確認
    dbTier: z.string().min(1).default("db-f1-micro"),
    dbVersion: z
      .string()
      .regex(/^MYSQL_[0-9_]+$/)
      .default("MYSQL_8_4"),
    dbDiskSizeGb: z.number().int().min(10).default(10), // 作成時の大きさ（最小）。足りなければ自動拡張（上限 dbDiskAutoresizeLimitGb）。縮小できないので作成後は使わない（ignoreChanges）
    dbDiskAutoresizeLimitGb: z.number().int().min(10).default(50),
    maintenanceWindow: z
      .object({ day: z.number().int().min(1).max(7), hour: z.number().int().min(0).max(23) })
      .strict()
      .default({ day: 2, hour: 18 }),
    releaseImages: ReleaseImages.nullable().default(null),
    appRuntime: z
      .record(z.string(), z.string())
      .nullable()
      .default(null)
      .refine(
        (m) => m === null || REQUIRED_RUNTIME_KEYS.every((k) => k in m),
        "app_runtime に必須の運用値（CALENDAR_* / BOT_RUN_*）が足りない",
      ),
    alertEmail: z.union([z.literal(""), email]).default(""),
    billingAccountId: z.union([z.literal(""), z.string().regex(/^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$/)]).default(""),
    monthlyBudgetJpy: z.number().int().positive().default(3000), // 本人の上限（web D-277・D-278）。超過の通知だけで、止めはしない
    schedulerResumeOnCreate: z.boolean().default(false),
    // web の release.yml がイメージを push する権限（web D-276）。CONTRACTS §1『push 権限は推測しない』ので既定は無効。本人の承認後に true
    enableWebPush: z.boolean().default(false),
  })
  .strict()
  // variables.tf の admin_users の検証と同じ: 管理者は許可リストの中から（レビュー 中）
  .refine((c) => c.adminUsers.every((u) => c.allowedUsers.includes(u)), {
    message: "adminUsers は allowedUsers の中から",
    path: ["adminUsers"],
  });
export type InfraConfig = z.infer<typeof InfraConfig>;

/** 失敗は項目名と理由だけ（値は出さない）。 */
export function parseConfig(raw: unknown): InfraConfig {
  const r = InfraConfig.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`Pulumi の設定が不正: ${issues}`);
  }
  return r.data;
}

const STRING_KEYS = [
  "projectId",
  "projectNumber",
  "region",
  "githubRepoInfra",
  "githubRepoWeb",
  "dbTier",
  "dbVersion",
  "alertEmail",
  "billingAccountId",
] as const;
const NUMBER_KEYS = ["tenantId", "dbDiskSizeGb", "dbDiskAutoresizeLimitGb", "monthlyBudgetJpy"] as const;
const BOOLEAN_KEYS = ["schedulerResumeOnCreate", "enableWebPush"] as const;
const JSON_KEYS = ["allowedUsers", "adminUsers", "maintenanceWindow", "releaseImages", "appRuntime"] as const;

/**
 * stack の設定（`jrabot:<key>`。Pulumi の設定は文字列で保存される）を型ごとに読む（レビュー 高: すべてを getObject = JSON.parse で読んでいたため、
 * 通常の文字列の設定が例外になり、数字の文字列は数値になっていた）。文字列はそのまま、数値・真偽は厳密に変換、配列・オブジェクトだけ JSON。
 * 失敗は項目名と理由だけ（値は出さない）。
 */
export function readConfig(get: (key: string) => string | undefined): InfraConfig {
  const raw: Record<string, unknown> = {};
  const bad: string[] = [];
  for (const k of STRING_KEYS) {
    const v = get(k);
    if (v !== undefined) raw[k] = v;
  }
  for (const k of NUMBER_KEYS) {
    const v = get(k);
    if (v === undefined) continue;
    if (/^-?[0-9]+$/.test(v)) raw[k] = Number(v);
    else bad.push(`${k}: 整数ではない`);
  }
  for (const k of BOOLEAN_KEYS) {
    const v = get(k);
    if (v === undefined) continue;
    if (v === "true" || v === "false") raw[k] = v === "true";
    else bad.push(`${k}: true / false ではない`);
  }
  for (const k of JSON_KEYS) {
    const v = get(k);
    if (v === undefined) continue;
    try {
      raw[k] = JSON.parse(v);
    } catch {
      bad.push(`${k}: JSON として読めない`);
    }
  }
  if (bad.length > 0) throw new Error(`Pulumi の設定が不正: ${bad.join("; ")}`);
  return parseConfig(raw);
}
