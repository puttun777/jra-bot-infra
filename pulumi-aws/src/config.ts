// スタックの設定（`pulumi config set jrabot-aws:<key>`）。外部入力なので zod で実行時に検査し、失敗したら定義を作らない。
// 秘密はここに置かない（Cognito の client secret は Pulumi の secret 出力 → SSM の SecureString。DB のパスワード等は ops aws secrets-init が作る）。
import { z } from "zod";

/** アプリの運用値（web CONTRACTS §2。CALENDAR_*・BOT_RUN_*。既定値は無い = 本人が決めた値を必ず入れる）。 */
export const REQUIRED_APP_KEYS = [
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

/** 秘密を app.env に入れさせない（control/app.env は秘密でない値だけ。秘密は SSM）。 */
const FORBIDDEN_APP_KEYS = /PASSWORD|SECRET|TOKEN|KEY|WEBHOOK|PEPPER|KEK/;

const email = z.string().regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "メールアドレスの形式");

const AwsInfraBase = z
  .object({
    /** 名前の接頭辞（S3 のバケット名は世界で一意なので、アカウント ID などを含める）。 */
    prefix: z.string().regex(/^[a-z][a-z0-9-]{2,20}$/),
    accountId: z.string().regex(/^\d{12}$/),
    /** EC2 の種類（既定 t4g.small = arm64。2026-11-13 の実測で同時稼働のピーク約 1.4 GiB。t3.small にするなら arch も amd64）。 */
    instanceType: z.enum(["t4g.small", "t4g.medium", "t3.small", "t3.medium"]).default("t4g.small"),
    /** Amazon Linux 2023 の AMI（固定する。自動で変えるとインスタンスを作り直してしまう）。arm64/x86_64 は instanceType に合わせる。 */
    amiId: z.string().regex(/^ami-[0-9a-f]{8,17}$/),
    /** CPU クレジット（unlimited: 起動直後の JVM でも遅くならない。超過分は課金: docs/AWS_ARCHITECTURE.md §8）。 */
    cpuCredits: z.enum(["unlimited", "standard"]).default("unlimited"),
    availabilityZone: z
      .string()
      .regex(/^ap-northeast-1[a-d]$/)
      .default("ap-northeast-1c"),
    rootVolumeGb: z.number().int().min(10).max(40).default(12),
    dataVolumeGb: z.number().int().min(10).max(200).default(16),
    /** データの EBS の週 1 回のスナップショットの世代数（0 なら作らない。S3 の論理バックアップが主）。 */
    snapshotRetain: z.number().int().min(0).max(8).default(2),
    /** S3 の論理バックアップの保持日数（ライフサイクルで消す: 費用が増え続けない）。 */
    backupRetentionDays: z.number().int().min(7).max(400).default(35),
    /** 画面の FQDN（独自ドメイン。Let's Encrypt の証明書・Cognito の戻り先）。本人が用意する: docs/AWS_OPERATIONS.md U2。 */
    siteHost: z.string().regex(/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
    /** Route 53 のホストゾーン（既にあれば ID、無ければ createZone で作る。親のドメインから NS を委任する）。 */
    dnsZoneId: z
      .string()
      .regex(/^Z[0-9A-Z]{5,32}$/)
      .optional(),
    createZone: z.boolean().default(false),
    zoneName: z.string().optional(),
    /** Cognito の hosted UI のドメインの接頭辞（<prefix>.auth.ap-northeast-1.amazoncognito.com。無料）。 */
    cognitoDomainPrefix: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/),
    /** 本人のメール（Cognito の利用者・oauth2-proxy の許可・アプリの ALLOWED_USERS）。1 名だけ（web REQUIREMENTS §0）。 */
    ownerEmail: email,
    /** GitHub の所有者（OIDC の信頼の条件）。 */
    githubOwner: z.string().regex(/^[A-Za-z0-9-]{1,39}$/),
    /** 既存の GitHub の OIDC プロバイダ（アカウントに 1 つだけ。無ければ作る）。 */
    githubOidcProviderArn: z
      .string()
      .regex(/^arn:aws:iam::\d{12}:oidc-provider\/token\.actions\.githubusercontent\.com$/)
      .optional(),
    /** web の release から ECR へ push する権限（本人の承認後に true: web USER_ACTIONS）。 */
    enableWebPush: z.boolean().default(false),
    /** 予算の通知（強制停止ではない）。USD/月。通知先のメール。 */
    budgetUsd: z.number().min(1).max(200).default(20),
    budgetEmail: email.optional(),
    /** アプリの運用値（control/app.env）。CALENDAR_*・BOT_RUN_* は必須。ALLOWED_USERS・ADMIN_USERS は ownerEmail から作る。 */
    appEnv: z.record(
      z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
      z
        .string()
        .max(500)
        .regex(/^[^\r\n]*$/),
    ),
    /** 制御の設定（Lambda の CONTROLLER_CONFIG。省略時は ops の既定）。 */
    controller: z.record(z.string(), z.number().int()).optional(),
    /** サードパーティのイメージ（tag と digest の両方で固定。ops aws deploy が release.json に書く: docs/AWS_OPERATIONS.md §6）。 */
    hostImages: z
      .object({
        mysql: z.string().regex(/^(docker\.io\/library\/)?mysql:[A-Za-z0-9._-]{1,64}@sha256:[0-9a-f]{64}$/),
        caddy: z.string().regex(/^(docker\.io\/library\/)?caddy:[A-Za-z0-9._-]{1,64}@sha256:[0-9a-f]{64}$/),
        oauth2Proxy: z.string().regex(/^quay\.io\/oauth2-proxy\/oauth2-proxy:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/),
      })
      .strict(),
  })
  .strict();

export const AwsInfraConfig = AwsInfraBase.superRefine((c, ctx) => {
  for (const k of REQUIRED_APP_KEYS)
    if (!(k in c.appEnv))
      ctx.addIssue({ code: "custom", message: `appEnv に ${k} が無い（運用値は本人が決める: web CONTRACTS §2）`, path: ["appEnv"] });
  for (const k of Object.keys(c.appEnv))
    if (FORBIDDEN_APP_KEYS.test(k))
      ctx.addIssue({ code: "custom", message: `appEnv に秘密（${k}）を入れない（SSM に置く）`, path: ["appEnv"] });
  const arm = c.instanceType.startsWith("t4g");
  if (c.dnsZoneId === undefined && !c.createZone)
    ctx.addIssue({
      code: "custom",
      message: "dnsZoneId か createZone=true のどちらかが必要（画面の HTTPS に独自ドメインを使う）",
      path: ["dnsZoneId"],
    });
  if (c.createZone && (c.zoneName === undefined || (!c.siteHost.endsWith(`.${c.zoneName}`) && c.siteHost !== c.zoneName)))
    ctx.addIssue({ code: "custom", message: "createZone のときは zoneName（siteHost を含む）が必要", path: ["zoneName"] });
  void arm;
});
export type AwsInfraConfig = z.infer<typeof AwsInfraConfig>;

export function arch(c: Pick<AwsInfraConfig, "instanceType">): "arm64" | "amd64" {
  return c.instanceType.startsWith("t4g") ? "arm64" : "amd64";
}

/** Pulumi の Config から読む（配列・オブジェクトは JSON の文字列）。 */
export function readConfig(get: (k: string) => string | undefined): AwsInfraConfig {
  const raw: Record<string, unknown> = {};
  const json = new Set([
    "appEnv",
    "controller",
    "hostImages",
    "createZone",
    "enableWebPush",
    "rootVolumeGb",
    "dataVolumeGb",
    "snapshotRetain",
    "backupRetentionDays",
    "budgetUsd",
  ]);
  for (const k of Object.keys(AwsInfraBase.shape)) {
    const v = get(k);
    if (v === undefined) continue;
    raw[k] = json.has(k) ? (JSON.parse(v) as unknown) : v;
  }
  return AwsInfraConfig.parse(raw);
}

/** control/app.env の内容（秘密でない運用値 + 本人だけの許可）。 */
export function renderAppEnv(c: AwsInfraConfig): string {
  const env: Record<string, string> = { ...c.appEnv, ALLOWED_USERS: c.ownerEmail, ADMIN_USERS: c.ownerEmail };
  return `${Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`;
}

/** Node の公式の配布物（nodejs.org の SHASUMS256.txt で確認した値。2026-11-13）。 */
export const NODE = {
  version: "v24.22.2",
  sha256: {
    arm64: "eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8",
    x64: "48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75",
  },
} as const;
