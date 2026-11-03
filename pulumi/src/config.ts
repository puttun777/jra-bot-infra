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
    dbTier: z.string().min(1).default("db-g1-small"),
    dbVersion: z
      .string()
      .regex(/^MYSQL_[0-9_]+$/)
      .default("MYSQL_8_4"),
    dbDiskSizeGb: z.number().int().min(10).default(20),
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
    monthlyBudgetJpy: z.number().int().positive().default(12000),
    schedulerResumeOnCreate: z.boolean().default(false),
  })
  .strict();
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
