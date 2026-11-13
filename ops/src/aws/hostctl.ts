/**
 * EC2 の上の運用エージェント `jrabot-host`（systemd が起動する。root で動く。秘密は SSM から読んで tmpfs の /run/jrabot に置く）。
 *
 *   jrabot-host boot                 起動時の準備（秘密・環境・DB の利用者・スキーマの確認）。終わるまでアプリを動かさない
 *   jrabot-host tick                 1 分ごと: 運用状態に合わせてサービス・開催日の処理・排出を行い、S3 に報告する
 *   jrabot-host backup [--reason R]  MySQL の整合したバックアップ（mysqldump --single-transaction）→ gzip → S3（SHA-256 で検証）
 *   jrabot-host restore --key K --confirm RESTORE-<日付>   バックアップから戻す（事前に現状のバックアップを取る。手順は合成データで試験済み）
 *   jrabot-host deploy               S3 の control/release-candidate.json のイメージに入れ替える（バックアップ → migrate → 再起動）。
 *                                    成功したときだけ control/release.json に昇格する（失敗したら前の版のまま。次の起動も前の版）
 *   jrabot-host run-batch --task=T [--from=… --to=…]   重い処理（batch の起動目的のときだけ）
 *
 * 判断は host.ts（純粋な関数）、コンテナの定義は services.ts（純粋なデータ）。ここは Docker・S3・SSM の実行だけ。
 * コマンドの引数に秘密を入れない（ファイル・標準入力・root だけが読める env ファイル）。
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { z } from "zod";
import { privateKeyFromSecret, publicKeyRaw } from "../beacon.js";
import { errorMessage } from "../json.js";
import { MODES } from "../state.js";
import { clients, S3Json, secureParameter } from "./adapters.js";
import { type HostAction, type HostFacts, MYSQLDUMP_ARGS, parseJobResult, planHost, SpoolRequestSchema } from "./host.js";
import { type HostStatus, WorkloadsSchema } from "./model.js";
import {
  assertPinned,
  assertTrustedImages,
  type ContainerSpec,
  dockerRunArgs,
  type HostImages,
  type JobKind,
  job,
  NETWORK,
  NETWORK_APP_RANGE,
  NETWORK_NO_IMDS_RANGE,
  NETWORK_SUBNET,
  type ServiceSettings,
  services as serviceSpecs,
} from "./services.js";

const RUN = "/run/jrabot";
const VAR = "/var/lib/jrabot";
const SPOOL = "/var/spool/jrabot";
const RELEASE_FILE = `${RUN}/release.json`;

/** /etc/jrabot/host.json（Pulumi の user data が書く。秘密を含まない）。 */
const HostConfigSchema = z.object({
  instance_id: z
    .string()
    .regex(/^i-[0-9a-f]{8,17}$/)
    .optional(),
  state_bucket: z.string().min(3),
  backup_bucket: z.string().min(3),
  models_bucket: z.string().min(3),
  ssm_prefix: z.string().regex(/^\/[A-Za-z0-9/_-]+$/),
  ecr_registry: z.string().regex(/^\d{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com$/),
  /** 連続稼働の上限（時間）。制御が動かない場合の最後の安全網（制御の上限 20 時間より長くする）。 */
  max_uptime_hours: z.number().int().min(6).max(72).default(30),
  site_host: z.string().max(253),
  cognito_issuer: z.string().url(),
  cognito_client_id: z.string().min(1),
  allowed_emails: z.array(z.string().email()).min(1).max(5),
  calendar_interval_seconds: z.number().int().min(60).max(1800).default(300),
  backup_keep_local: z.number().int().min(1).max(5).default(2),
});
type HostConfig = z.infer<typeof HostConfigSchema>;

/** S3 の control/release.json（host deploy が成功したときだけ書く）と control/release-candidate.json（ops aws deploy が置く）。
 *  web の release-manifest に、サードパーティのイメージの digest（host_images）を足したもの。 */
const RELEASE_KEY = "control/release.json";
const CANDIDATE_KEY = "control/release-candidate.json";
const ReleaseSchema = z.looseObject({
  release: z.string(),
  git_sha: z.string().regex(/^[0-9a-f]{40}$/),
  images: z.looseObject({ dashboard: z.string(), ingest: z.string(), bot: z.string(), "db-migration": z.string(), "ml-train": z.string() }),
  host_images: z.object({ mysql: z.string(), caddy: z.string(), "oauth2-proxy": z.string() }),
});

export class HostError extends Error {
  override readonly name = "HostError";
}

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

function run(cmd: readonly string[], opts: { timeoutSec?: number; input?: string } = {}): Run {
  const [bin, ...args] = cmd;
  if (bin === undefined) throw new HostError("空のコマンド");
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: (opts.timeoutSec ?? 120) * 1000,
    input: opts.input,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { code: r.status ?? (r.signal === null ? 1 : 124), out: r.stdout ?? "", err: r.stderr ?? "" };
}

function must(cmd: readonly string[], what: string, timeoutSec?: number): string {
  const r = run(cmd, timeoutSec === undefined ? {} : { timeoutSec });
  if (r.code !== 0) throw new HostError(`${what} が失敗（${r.code}）: ${r.err.trim().split("\n").slice(-2).join(" / ").slice(0, 300)}`);
  return r.out;
}

const nowIso = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const jstDate = (t = Date.now()): string => new Date(t + 9 * 3600_000).toISOString().slice(0, 10);

function readJsonFile<T>(path: string, schema: z.ZodType<T>): T | undefined {
  try {
    return schema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

function writeAtomic(path: string, content: string | Uint8Array, mode = 0o600): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, path);
}

function config(): HostConfig {
  return HostConfigSchema.parse(JSON.parse(readFileSync("/etc/jrabot/host.json", "utf8")));
}

// ------------------------------------------------------------------ コンテナ（docker）
function images(): HostImages {
  const r = ReleaseSchema.parse(JSON.parse(readFileSync(RELEASE_FILE, "utf8")));
  const img: HostImages = {
    dashboard: r.images.dashboard,
    ingest: r.images.ingest,
    bot: r.images.bot,
    dbMigration: r.images["db-migration"],
    mlTrain: r.images["ml-train"],
    mysql: r.host_images.mysql,
    caddy: r.host_images.caddy,
    oauth2Proxy: r.host_images["oauth2-proxy"],
  };
  assertPinned(img);
  assertTrustedImages(img, config().ecr_registry);
  return img;
}

function settings(cfg: HostConfig): ServiceSettings {
  return {
    stateBucket: cfg.state_bucket,
    modelsBucket: cfg.models_bucket,
    siteHost: cfg.site_host,
    cognitoIssuer: cfg.cognito_issuer,
    cognitoClientId: cfg.cognito_client_id,
  };
}

function containerState(name: string): "running" | "stopped" | "missing" {
  const r = run(["docker", "inspect", "--format", "{{.State.Running}}", name], { timeoutSec: 20 });
  if (r.code !== 0) return "missing";
  return r.out.trim() === "true" ? "running" : "stopped";
}

/** サービスを起動する（止まっている・古い定義のコンテナは消して作り直す。データは /data のボリュームにある）。 */
function up(spec: ContainerSpec): void {
  if (containerState(spec.container) === "running") return;
  run(["docker", "rm", "--force", spec.container], { timeoutSec: 60 });
  must(["docker", ...dockerRunArgs(spec, { detach: true, remove: false })], `${spec.name} の起動`, 600);
}

function stop(container: string, timeoutSec: number): void {
  if (containerState(container) === "missing") return;
  run(["docker", "stop", "--time", String(timeoutSec), container], { timeoutSec: timeoutSec + 30 });
}

function runJob(
  kind: JobKind,
  cfg: HostConfig,
  container: string,
  command: readonly string[],
  opts: { detach: boolean; timeoutSec: number },
): Run {
  const spec = job(kind, images(), settings(cfg), container, command);
  run(["docker", "rm", "--force", container], { timeoutSec: 30 });
  return run(["docker", ...dockerRunArgs(spec, { detach: opts.detach, remove: true })], { timeoutSec: opts.timeoutSec });
}

function botTask(
  cfg: HostConfig,
  task: string,
  extra: readonly string[],
  opts: { detach?: boolean; timeoutSec: number; container?: string; kind?: JobKind },
): Run {
  return runJob(
    opts.kind ?? "bot-task",
    cfg,
    opts.container ?? `jrabot-${task}-${randomBytes(3).toString("hex")}`,
    [`--task=${task}`, "--tenant-id=1", ...extra],
    {
      detach: opts.detach ?? false,
      timeoutSec: opts.timeoutSec,
    },
  );
}

function mysqlExec(sql: string): Run {
  return run(
    [
      "docker",
      "exec",
      "-i",
      "jrabot-mysql",
      "mysql",
      "--defaults-extra-file=/run/secrets/mysql-root.cnf",
      "--batch",
      "--skip-column-names",
    ],
    { input: sql, timeoutSec: 120 },
  );
}

// ------------------------------------------------------------------ 事実の収集
const CalendarFile = z.object({ at: z.string(), reason: z.string(), date: z.string() });
const DoneFile = z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(20);
const BackupFile = z.object({
  last_ok_at: z.string().nullable(),
  last_failed_at: z.string().nullable(),
  last_key: z.string().nullable(),
  last_error: z.string().nullable(),
});
const NO_BACKUP = { last_ok_at: null, last_failed_at: null, last_key: null, last_error: null };
const OpsView = z.looseObject({ seq: z.number().int(), mode: z.enum(MODES), workloads: WorkloadsSchema.optional() });
/** restore の前提: 保守の起動目的（MAINTENANCE）が十分に残っている（途中で排出・停止に入らない）。 */
const MaintenanceView = z.looseObject({
  mode: z.enum(MODES),
  aws: z.looseObject({ holds: z.array(z.looseObject({ purpose: z.string(), expires_at: z.string() })) }),
});
const SERVICE_CONTAINERS: Readonly<Record<string, string>> = {
  mysql: "jrabot-mysql",
  dashboard: "jrabot-dashboard",
  ingest: "jrabot-ingest",
  "oauth2-proxy": "jrabot-oauth2-proxy",
  caddy: "jrabot-caddy",
};

function serviceStates(): Record<string, "running" | "stopped"> {
  const out: Record<string, "running" | "stopped"> = {};
  for (const [svc, c] of Object.entries(SERVICE_CONTAINERS)) out[svc] = containerState(c) === "running" ? "running" : "stopped";
  return out;
}

function spoolEntries(): HostFacts["spool"] {
  if (!existsSync(SPOOL)) return [];
  return readdirSync(SPOOL)
    .filter((f) => f.endsWith(".json") && !f.startsWith(".") && f !== "calendar-plan.json")
    .sort()
    .slice(0, 20)
    .map((file) => {
      try {
        const p = join(SPOOL, file);
        if (statSync(p).size > 4096) return { file, request: undefined };
        return { file, request: SpoolRequestSchema.parse(JSON.parse(readFileSync(p, "utf8"))) };
      } catch {
        return { file, request: undefined };
      }
    });
}

/**
 * 制御（Lambda）が止まっているように見えるか: 運用状態が 3 時間以上書かれていない（動いている間は DNS の書直しで 1 時間ごとに書かれる）か読めない。
 * 制御が動いているなら、停止は制御に任せる（開催日の途中に自分で止まらない）。
 */
async function controllerLooksDead(cfg: HostConfig): Promise<boolean> {
  try {
    const h = await clients.s3().send(new HeadObjectCommand({ Bucket: cfg.state_bucket, Key: "state/ops-state.json" }));
    return h.LastModified === undefined || Date.now() - h.LastModified.getTime() > 3 * 3600_000;
  } catch {
    return true;
  }
}

async function readOps(cfg: HostConfig): Promise<HostFacts["ops"]> {
  try {
    const r = await new S3Json(clients.s3(), cfg.state_bucket).read("state/ops-state.json");
    const v = r === undefined ? undefined : OpsView.parse(r.raw);
    if (v === undefined) return undefined;
    return { seq: v.seq, mode: v.mode, raceday: v.workloads?.raceday ?? false, batch: v.workloads?.batch ?? false };
  } catch {
    return undefined; // 読めない = UNKNOWN（何もしない）
  }
}

// ------------------------------------------------------------------ 実行
async function execute(a: HostAction, cfg: HostConfig, status: Partial<HostStatus>): Promise<void> {
  switch (a.type) {
    case "up": {
      const specs = serviceSpecs(images(), settings(cfg));
      for (const s of a.services) up(specs[s]);
      return;
    }
    case "stop":
      for (const s of a.services) stop(SERVICE_CONTAINERS[s] ?? `jrabot-${s}`, 60);
      return;
    case "stop-job":
      // SIGTERM → アプリが checkpoint を保存して終わる（bot-run は CONTRACTS §9.2）。90 秒で SIGKILL
      stop(a.job === "bot-run" ? "jrabot-botrun" : "jrabot-batch", 90);
      return;
    case "calendar-check": {
      const r = botTask(cfg, "calendar-check", [], { timeoutSec: 180 });
      const res = parseJobResult(r.out + r.err, "calendar-check");
      const reason = res?.reason ?? `EXIT_${r.code}`;
      writeAtomic(join(VAR, "calendar.json"), JSON.stringify({ at: nowIso(), reason, date: jstDate() }));
      status.calendar = { last_reason: reason, at: nowIso() };
      return;
    }
    case "launch-bot-run": {
      rmSync(join(SPOOL, a.file), { force: true });
      if (!/^(SCHEDULER|MANUAL|RECONCILE|BACKFILL)$/.test(a.trigger) || !/^\d{4}-\d{2}-\d{2}$/.test(a.date))
        throw new HostError("起動依頼の値が不正");
      const r = botTask(cfg, "bot-run", [`--date=${a.date}`, `--trigger=${a.trigger}`], {
        detach: true,
        timeoutSec: 120,
        container: "jrabot-botrun",
        kind: "bot-run",
      });
      if (r.code !== 0) throw new HostError(`bot-run を起動できない（${r.code}）`);
      return;
    }
    case "discard-spool":
      renameSync(join(SPOOL, a.file), join(SPOOL, `.discarded-${a.file}`));
      console.log(`spool: ${a.file} を捨てた（${a.reason}）`);
      return;
    case "finish-raceday": {
      // その日の後処理: 結果・払戻の照合（reconcile）→ 先の予定の書出し → 終わりの記録（制御が RACEDAY の hold を外す）
      // 照合が失敗したら終わりにしない（hold は窓の終わりまで残り、15 分ごとに再試行する。失敗の通知は bot が出す）
      const retry = join(VAR, `reconcile-retry-${a.date}`);
      if (existsSync(retry) && Date.now() - Date.parse(readFileSync(retry, "utf8").trim()) < 15 * 60_000) return;
      const rec = botTask(cfg, "reconcile", [`--date=${a.date}`], { timeoutSec: 900 });
      if (rec.code !== 0) {
        writeAtomic(retry, nowIso());
        console.log(`reconcile が失敗（${rec.code}）。15 分後に再試行`);
        return;
      }
      rmSync(retry, { force: true });
      await exportPlan(cfg);
      const done = readJsonFile(join(VAR, "raceday-done.json"), DoneFile) ?? [];
      writeAtomic(join(VAR, "raceday-done.json"), JSON.stringify([...done.filter((d) => d !== a.date), a.date].slice(-20)));
      return;
    }
    case "drain":
      await drain(cfg, status);
      return;
  }
}

async function exportPlan(cfg: HostConfig): Promise<void> {
  const r = botTask(cfg, "calendar-plan", ["--days=45", "--out=/spool/calendar-plan.json"], { timeoutSec: 180 });
  const p = join(SPOOL, "calendar-plan.json");
  if (r.code !== 0 || !existsSync(p)) {
    console.log(`calendar-plan を書き出せない（${r.code}）`);
    return;
  }
  await new S3Json(clients.s3(), cfg.state_bucket).put("control/calendar-plan.json", readFileSync(p), "application/json", "no-store");
  renameSync(p, join(VAR, "calendar-plan.last.json"));
  writeAtomic(join(VAR, "plan-exported-at"), nowIso());
}

/** 排出: 新規の受付停止 → 実行中の処理の終了 → バックアップ → 停止 → 電源断（停止の動作は stop: EBS は残る）。 */
async function drain(cfg: HostConfig, status: Partial<HostStatus>): Promise<void> {
  status.phase = "DRAINING";
  await report(cfg, status).catch(() => {});
  stop("jrabot-ingest", 30);
  for (const c of ["jrabot-botrun", "jrabot-batch"]) stop(c, 90);
  if (containerState("jrabot-mysql") === "running") {
    try {
      await backup(cfg, "stop");
    } catch (e) {
      console.log(`停止時のバックアップが失敗: ${errorMessage(e).slice(0, 200)}（EBS のデータは残る。停止は続ける）`);
    }
  }
  for (const c of ["jrabot-caddy", "jrabot-oauth2-proxy", "jrabot-dashboard"]) stop(c, 30);
  stop("jrabot-mysql", 120); // InnoDB の正常な停止を待つ
  writeFileSync(join(RUN, "drained"), nowIso());
  status.phase = "DRAINED";
  status.backup = readJsonFile(join(VAR, "backup.json"), BackupFile) ?? NO_BACKUP;
  await report(cfg, status).catch(() => {});
  run(["systemctl", "poweroff"], { timeoutSec: 30 });
}

const sha256File = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });

/** MySQL の整合したバックアップ（InnoDB の一貫したスナップショット）→ gzip → S3。失敗を成功として記録しない。 */
export async function backup(cfg: HostConfig, reason: string): Promise<string> {
  const state = readJsonFile(join(VAR, "backup.json"), BackupFile) ?? NO_BACKUP;
  const dir = join("/data", "backup");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = nowIso().replace(/[-:]/g, "");
  const file = join(dir, `jrabot-${stamp}.sql.gz`);
  try {
    // 認証はコンテナ内の設定ファイル（パスワードを引数・環境変数に出さない）。--single-transaction で書込みを止めずに一貫した内容
    const dump = run(
      [
        "bash",
        "-o",
        "pipefail",
        "-c",
        `docker exec jrabot-mysql mysqldump --defaults-extra-file=/run/secrets/mysql-root.cnf ${MYSQLDUMP_ARGS.join(" ")} | gzip -6 > '${file}'`,
      ],
      { timeoutSec: 1800 },
    );
    if (dump.code !== 0) throw new HostError(`mysqldump が失敗（${dump.code}）: ${dump.err.trim().slice(-200)}`);
    const size = statSync(file).size;
    if (size < 200) throw new HostError("バックアップが小さすぎる（空の可能性）");
    const tail = run(["bash", "-o", "pipefail", "-c", `gzip -dc '${file}' | tail -n 1`], { timeoutSec: 600 });
    if (tail.code !== 0 || !tail.out.includes("Dump completed")) throw new HostError("バックアップの終わりの行が無い（途中で切れている）");
    const sha = await sha256File(file);
    const key = `mysql/${jstDate()}/jrabot-${stamp}-${reason.replace(/[^a-z0-9-]/g, "")}.sql.gz`;
    const s3 = clients.s3();
    await s3.send(
      new PutObjectCommand({
        Bucket: cfg.backup_bucket,
        Key: key,
        Body: createReadStream(file),
        ContentLength: size,
        ContentType: "application/gzip",
        ChecksumAlgorithm: "SHA256",
        Metadata: { sha256: sha, reason },
        IfNoneMatch: "*",
      }),
    );
    const head = await s3.send(new HeadObjectCommand({ Bucket: cfg.backup_bucket, Key: key }));
    if (head.ContentLength !== size || head.Metadata?.["sha256"] !== sha) throw new HostError("アップロードの大きさ・ハッシュが一致しない");
    writeAtomic(join(VAR, "backup.json"), JSON.stringify({ ...state, last_ok_at: nowIso(), last_key: key, last_error: null }));
    const local = readdirSync(dir)
      .filter((f) => f.startsWith("jrabot-") && f.endsWith(".sql.gz"))
      .sort();
    for (const f of local.slice(0, Math.max(0, local.length - cfg.backup_keep_local))) rmSync(join(dir, f), { force: true });
    console.log(`backup: ok ${key} ${size} bytes sha256=${sha}`);
    return key;
  } catch (e) {
    rmSync(file, { force: true });
    writeAtomic(
      join(VAR, "backup.json"),
      JSON.stringify({ ...state, last_failed_at: nowIso(), last_error: errorMessage(e).slice(0, 300) }),
    );
    throw e;
  }
}

/** バックアップから戻す（事前に現状のバックアップを取り、アプリを止めてから流し込む）。確認の文字列が必須。 */
async function restore(cfg: HostConfig, key: string, confirm: string): Promise<void> {
  if (!/^mysql\/\d{4}-\d{2}-\d{2}\/jrabot-[0-9TZ]+-[a-z0-9-]*\.sql\.gz$/.test(key)) throw new HostError("キーの形式が不正");
  if (confirm !== `RESTORE-${key.slice(6, 16)}`) throw new HostError(`確認の文字列が違う（RESTORE-${key.slice(6, 16)} を指定する）`);
  // 開催日・重い処理の最中は戻さない（書込み中のコンテナと重なると結果が壊れる）。保守の起動（aws-maintenance。90 分以上残っている）で行う:
  // 途中で期限が切れて排出・停止に入ると、DB を作り直した後の流し込みが切られる
  const ops = await readOps(cfg);
  if (ops === undefined || ops.raceday || ops.batch || ops.mode !== "NORMAL")
    throw new HostError("運用モードが NORMAL で、開催日・重い処理の起動目的が無いときだけ戻す（aws-maintenance で起動する）");
  const raw = (await new S3Json(clients.s3(), cfg.state_bucket).read("state/ops-state.json"))?.raw;
  const mv = MaintenanceView.safeParse(raw);
  const until = mv.success
    ? Math.max(0, ...mv.data.aws.holds.filter((h) => h.purpose === "MAINTENANCE").map((h) => Date.parse(h.expires_at)))
    : 0;
  if (until - Date.now() < 90 * 60_000)
    throw new HostError("保守の起動目的（MAINTENANCE）が 90 分以上残っていない（aws-maintenance で起動・延長する）");
  for (const j of ["jrabot-botrun", "jrabot-batch"])
    if (containerState(j) === "running") throw new HostError(`${j} が動いている間は戻さない`);
  const preKey = await backup(cfg, "pre-restore");
  const obj = await clients.s3().send(new GetObjectCommand({ Bucket: cfg.backup_bucket, Key: key, ChecksumMode: "ENABLED" }));
  const bytes = await obj.Body?.transformToByteArray();
  if (bytes === undefined) throw new HostError("バックアップを読めない");
  if (obj.Metadata?.["sha256"] !== createHash("sha256").update(bytes).digest("hex"))
    throw new HostError("バックアップのハッシュが一致しない（壊れている）");
  const file = join("/data", "backup", "restore.sql.gz");
  writeAtomic(file, bytes);
  // 完全な dump か（最後の行）を、DB を消す前に確かめる
  if (run(["bash", "-o", "pipefail", "-c", `gzip -dc '${file}' | tail -c 300 | grep -q 'Dump completed'`], { timeoutSec: 600 }).code !== 0)
    throw new HostError("バックアップが途中で切れている（Dump completed が無い）");
  for (const c of ["jrabot-caddy", "jrabot-oauth2-proxy", "jrabot-dashboard", "jrabot-ingest", "jrabot-botrun", "jrabot-batch"])
    stop(c, 60);
  // 戻す前の版より新しい表を残さない（dump に無い表は消えないため）。利用者と権限は mysql の側にあるので残る。直前のバックアップは pre-restore
  if (mysqlExec("DROP DATABASE IF EXISTS jrabot;").code !== 0) throw new HostError("DB を作り直せない");
  try {
    must(
      [
        "bash",
        "-o",
        "pipefail",
        "-c",
        `gzip -dc '${file}' | docker exec -i jrabot-mysql mysql --defaults-extra-file=/run/secrets/mysql-root.cnf`,
      ],
      "流し込み",
      3600,
    );
  } catch (e) {
    throw new HostError(
      `流し込みが失敗した（DB は不完全）。直前のバックアップ ${preKey} で同じ手順をやり直す: ${errorMessage(e).slice(0, 200)}`,
    );
  }
  rmSync(file, { force: true });
  console.log(`restore: ${key} を戻した（アプリは次の tick で起動する）`);
}

async function report(cfg: HostConfig, status: Partial<HostStatus>): Promise<void> {
  const svc = serviceStates();
  const meminfo = readFileSync("/proc/meminfo", "utf8");
  const kb = (k: string): number => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(meminfo)?.[1] ?? "0") / 1024;
  const full: HostStatus = {
    schema_version: 1,
    instance_id: cfg.instance_id ?? "i-00000000",
    boot_id: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    reported_at: nowIso(),
    seen_seq: status.seen_seq ?? 0,
    phase: status.phase ?? (existsSync(join(RUN, "prepared")) ? "READY" : "BOOTING"),
    ready: status.ready ?? { mysql: svc["mysql"] === "running", dashboard: false, ingest: false },
    workloads_applied: status.workloads_applied ?? { raceday: false, batch: false },
    bot_run: { running: containerState("jrabot-botrun") === "running", date: null },
    batch: { running: containerState("jrabot-batch") === "running", job: null },
    raceday_done: readJsonFile(join(VAR, "raceday-done.json"), DoneFile) ?? [],
    backup: status.backup ?? readJsonFile(join(VAR, "backup.json"), BackupFile) ?? NO_BACKUP,
    memory_mb: {
      total: Math.round(kb("MemTotal")),
      available: Math.round(kb("MemAvailable")),
      swap_used: Math.round(kb("SwapTotal") - kb("SwapFree")),
    },
    ...(status.calendar === undefined ? {} : { calendar: status.calendar }),
  };
  await new S3Json(clients.s3(), cfg.state_bucket).put("status/host.json", JSON.stringify(full), "application/json", "no-store");
}

/** /internal/ready（内部トークンはファイルの Authorization ヘッダー。外向きのプロキシは /internal を通さない）。 */
function readyOf(port: number): boolean {
  const r = run(
    [
      "curl",
      "-s",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "--max-time",
      "5",
      "-H",
      `@${join(RUN, "internal-auth-header")}`,
      `http://127.0.0.1:${port}/internal/ready`,
    ],
    {
      timeoutSec: 10,
    },
  );
  return r.out.trim() === "200";
}

async function tick(cfg: HostConfig): Promise<void> {
  // 最後の安全網: 制御（Lambda）が動かなくても、連続稼働の上限を超えたら自分で排出して止まる（停止し忘れの費用を限る）
  const uptimeHours = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) / 3600;
  if (
    Number.isFinite(uptimeHours) &&
    uptimeHours > cfg.max_uptime_hours &&
    !existsSync(join(RUN, "drained")) &&
    (await controllerLooksDead(cfg))
  ) {
    console.log(`稼働 ${uptimeHours.toFixed(1)} 時間が上限 ${cfg.max_uptime_hours} 時間を超えた。排出して停止する`);
    await drain(cfg, {});
    return;
  }
  const ops = await readOps(cfg);
  const prepared = existsSync(join(RUN, "prepared"));
  const facts: HostFacts = {
    now: nowIso(),
    ops,
    services: serviceStates(),
    botRun: { running: containerState("jrabot-botrun") === "running", date: null },
    batch: { running: containerState("jrabot-batch") === "running", job: null },
    lastCalendar: readJsonFile(join(VAR, "calendar.json"), CalendarFile),
    spool: spoolEntries(),
    racedayDone: readJsonFile(join(VAR, "raceday-done.json"), DoneFile) ?? [],
    drained: existsSync(join(RUN, "drained")),
    prepared,
  };
  const status: Partial<HostStatus> = { seen_seq: ops?.seq ?? 0 };
  const actions = planHost(facts, { calendarIntervalSeconds: cfg.calendar_interval_seconds });
  for (const a of actions) {
    try {
      await execute(a, cfg, status);
    } catch (e) {
      console.log(`action ${a.type} が失敗: ${errorMessage(e).slice(0, 300)}`);
    }
  }
  if (facts.drained || actions.some((a) => a.type === "drain")) return;
  // 平常時の予定の書出し（6 時間ごと。停止中も制御が開催日を計画できるように）
  const lastPlan = existsSync(join(VAR, "plan-exported-at")) ? Date.parse(readFileSync(join(VAR, "plan-exported-at"), "utf8").trim()) : 0;
  if (ops?.mode === "NORMAL" && prepared && Date.now() - lastPlan > 6 * 3600_000) await exportPlan(cfg).catch(() => {});
  const after = serviceStates();
  status.ready = {
    mysql: after["mysql"] === "running",
    dashboard: after["dashboard"] === "running" && readyOf(18081),
    ingest: after["ingest"] === "running" && readyOf(18082),
  };
  status.workloads_applied = { raceday: ops?.raceday === true && after["ingest"] === "running", batch: ops?.batch === true };
  status.phase = prepared ? "READY" : "BOOTING";
  await report(cfg, status);
}

/** 秘密を root だけが読める env ファイルにする（docker の --env-file）。値は引数・ログに出さない。 */
function envFile(name: string, entries: Readonly<Record<string, string | undefined>>): void {
  const lines = Object.entries(entries)
    .filter((e): e is [string, string] => e[1] !== undefined && e[1] !== "")
    .map(([k, v]) => {
      if (/[\r\n]/.test(v)) throw new HostError(`${k} に改行が含まれる`);
      return `${k}=${v}`;
    });
  writeAtomic(join(RUN, "env", `${name}.env`), `${lines.join("\n")}\n`, 0o600);
}

/** 起動時の準備。秘密（SSM）→ tmpfs、内部トークンは起動ごとに新しく作る。DB の利用者を揃え、スキーマが最新でなければアプリを動かさない。 */
async function boot(cfg: HostConfig, releaseKey: string = RELEASE_KEY): Promise<void> {
  // データの EBS が付いていないと、MySQL がルートのディスクに空の DB を作ってしまう（バックアップも空になる）
  if (run(["mountpoint", "-q", "/data"], { timeoutSec: 10 }).code !== 0) throw new HostError("/data（データの EBS）がマウントされていない");
  for (const d of [join(RUN, "secrets"), join(RUN, "env")]) mkdirSync(d, { recursive: true, mode: 0o750 });
  mkdirSync(VAR, { recursive: true, mode: 0o700 });
  mkdirSync(SPOOL, { recursive: true, mode: 0o770 });
  run(["chown", "root:10001", SPOOL]);
  for (const d of ["/data/mysql", "/data/caddy", "/data/backup"]) mkdirSync(d, { recursive: true, mode: 0o750 });
  rmSync(join(RUN, "prepared"), { force: true });
  rmSync(join(RUN, "drained"), { force: true });
  const ssm = clients.ssm();
  const sec = async (n: string): Promise<string | undefined> => (await secureParameter(ssm, `${cfg.ssm_prefix}/${n}`))?.trim();
  const required = async (n: string): Promise<string> => {
    const v = await sec(n);
    if (v === undefined || v === "") throw new HostError(`SSM の ${n} が無い（ops aws secrets-init と USER_ACTIONS）`);
    return v;
  };
  // 秘密をファイルにする（コンテナの利用者 uid 10001 が読めるように群を合わせる。他の利用者は読めない）
  const secretFile = (n: string, v: string, mode = 0o440): void => {
    writeAtomic(join(RUN, "secrets", n), v, mode);
    run(["chown", "root:10001", join(RUN, "secrets", n)]);
  };
  const rootPw = await required("mysql-root");
  writeAtomic(join(RUN, "secrets", "mysql-root"), rootPw, 0o444); // MySQL のコンテナの利用者（mysql）が初期化で読む
  writeAtomic(join(RUN, "secrets", "mysql-root.cnf"), `[client]\nuser=root\npassword=${rootPw}\n`, 0o444);
  secretFile("cognito-client-secret", await required("cognito-client-secret"));
  const token = randomBytes(32).toString("base64url");
  secretFile("internal-ops-token", token);
  writeAtomic(join(RUN, "internal-auth-header"), `Authorization: Bearer ${token}\n`);
  writeAtomic(join(RUN, "allowed-emails"), `${cfg.allowed_emails.join("\n")}\n`, 0o444);
  envFile("dashboard", { DB_PASSWORD: await required("db-app"), INGEST_TOKEN_PEPPER: await required("ingest-token-pepper") });
  envFile("ingest", {
    DB_PASSWORD: await required("db-ingest"),
    INGEST_TOKEN_PEPPER: await required("ingest-token-pepper"),
    AGENT_KEK_KEYS: await required("agent-kek-keys"),
    AGENT_KEK_ACTIVE_KID: "k1",
  });
  // モデルの検証鍵（公開値）は署名鍵から導く（web CONTRACTS §5.1。生 32 バイトの Base64）。鍵の入替えの間の複数の鍵は手順書の『モデルの鍵の入替え』
  const modelKey = await sec("model-signing-key");
  const modelPub = modelKey === undefined ? undefined : publicKeyRaw(privateKeyFromSecret(modelKey)).toString("base64");
  envFile("bot", {
    DB_PASSWORD: await required("db-bot"),
    DISCORD_WEBHOOK_URL: await sec("discord-webhook"),
    DISCORD_ERROR_WEBHOOK_URL: await sec("discord-error-webhook"),
    MODEL_VERIFY_PUBKEY: modelPub,
  });
  envFile("db-migration", { DB_PASSWORD: await required("db-migrate") });
  envFile("ml-train", { DB_PASSWORD: await required("db-mltrain"), MODEL_SIGNING_KEY: modelKey, MODEL_VERIFY_PUBKEY: modelPub });
  envFile("oauth2-proxy", { OAUTH2_PROXY_COOKIE_SECRET: await required("oauth2-cookie-secret") });
  // アプリの運用値（CALENDAR_*・BOT_RUN_*・ALLOWED_USERS など。秘密ではない）とリリース（イメージの digest）。どちらも S3 の control/
  const s3 = clients.s3();
  const get = async (key: string, what: string): Promise<string> => {
    try {
      const o = await s3.send(new GetObjectCommand({ Bucket: cfg.state_bucket, Key: key }));
      return (await o.Body?.transformToString("utf-8")) ?? "";
    } catch {
      throw new HostError(`${key} を読めない（${what}）`);
    }
  };
  const appText = await get("control/app.env", "Pulumi が置く");
  if (!/^([A-Z][A-Z0-9_]{0,63}=[^\n]{0,2000}\n?)+$/.test(appText)) throw new HostError("control/app.env の形式が不正");
  writeAtomic(join(RUN, "app.env"), appText.endsWith("\n") ? appText : `${appText}\n`, 0o644);
  writeAtomic(RELEASE_FILE, await get(releaseKey, "先に ops aws deploy を実行する"), 0o644);
  const img = images(); // digest の固定を確かめる
  ensureNetwork();
  up(serviceSpecs(img, settings(cfg)).mysql);
  for (let i = 0; i < 60 && mysqlExec("SELECT 1;").code !== 0; i++) await new Promise((r) => setTimeout(r, 5000));
  ensureDbUsers();
  const v = runJob("db-migration", cfg, "jrabot-dbm-validate", ["--mode=validate"], { detach: false, timeoutSec: 300 });
  if (v.code === 10) throw new HostError("未適用のマイグレーションがある（deploy で適用する。起動時には適用しない）");
  if (v.code !== 0) throw new HostError(`スキーマの確認が失敗（${v.code}）`);
  writeFileSync(join(RUN, "prepared"), nowIso());
}

/**
 * コンテナのネットワークと IMDS の遮断（起動のたびに。iptables の規則は再起動で消える）。インターネットに面する Caddy・oauth2-proxy と MySQL は
 * 固定 IP（NETWORK_NO_IMDS_RANGE）で動かし、そこからの 169.254.169.254 への通信を落とす（services.ts の FIXED_IPS）。
 */
function ensureNetwork(): void {
  const inspect = run(["docker", "network", "inspect", "--format", "{{range .IPAM.Config}}{{.Subnet}} {{.IPRange}}{{end}}", NETWORK], {
    timeoutSec: 20,
  });
  if (inspect.code !== 0) {
    must(
      ["docker", "network", "create", "--driver", "bridge", "--subnet", NETWORK_SUBNET, "--ip-range", NETWORK_APP_RANGE, NETWORK],
      "ネットワークの作成",
    );
  } else if (inspect.out.trim() !== `${NETWORK_SUBNET} ${NETWORK_APP_RANGE}`) {
    throw new HostError(
      `ネットワーク ${NETWORK} の範囲が想定と違う（${inspect.out.trim().slice(0, 60)}）。手順書の『ネットワークの作り直し』`,
    );
  }
  const rule = ["DOCKER-USER", "-s", NETWORK_NO_IMDS_RANGE, "-d", "169.254.169.254/32", "-j", "DROP"];
  if (run(["iptables", "-C", ...rule], { timeoutSec: 20 }).code !== 0) must(["iptables", "-I", ...rule], "IMDS の遮断");
}

/** DB の利用者（CONTRACTS §8.2）を作る・パスワードを SSM の値に揃える。GRANT は R__grants.sql（db-migration）が行う。 */
function ensureDbUsers(): void {
  const users: Record<string, string> = {
    migrate: "env/db-migration.env",
    app: "env/dashboard.env",
    ingest: "env/ingest.env",
    bot: "env/bot.env",
    mltrain: "env/ml-train.env",
  };
  const lines: string[] = [];
  for (const [u, file] of Object.entries(users)) {
    const pw = /^DB_PASSWORD=(.*)$/m.exec(readFileSync(join(RUN, file), "utf8"))?.[1] ?? "";
    if (!/^[A-Za-z0-9_-]{24,128}$/.test(pw)) throw new HostError(`DB のパスワード（${u}）の形式が不正（ops aws secrets-init が作る）`);
    lines.push(`CREATE USER IF NOT EXISTS '${u}'@'%' IDENTIFIED BY '${pw}';`, `ALTER USER '${u}'@'%' IDENTIFIED BY '${pw}';`);
  }
  lines.push("GRANT ALL PRIVILEGES ON jrabot.* TO 'migrate'@'%' WITH GRANT OPTION;", "FLUSH PRIVILEGES;");
  if (mysqlExec(lines.join("\n")).code !== 0) throw new HostError("DB の利用者を作れない");
}

const BATCH_TASKS = new Set(["backtest", "export-dataset"]);
const BATCH_ARG =
  /^--(from|to|minutes-before-post|max-odds-age-seconds|dataset-id|feature-schema|valid-fraction|as-of-lead-minutes)=[A-Za-z0-9.,_-]{1,64}$/;
const ML_ARG = /^(train|--(tenant-id|dataset-id|config|gate)=[A-Za-z0-9.,_:/-]{1,128})$/;

async function runBatch(cfg: HostConfig, task: string, args: readonly string[]): Promise<number> {
  const ops = await readOps(cfg);
  if (ops?.mode !== "NORMAL" || !ops.batch) throw new HostError("batch の起動目的ではない（ops aws batch で起動してから）");
  if (task === "ml-train") {
    for (const a of args) if (!ML_ARG.test(a)) throw new HostError(`許されていない引数: ${a.slice(0, 40)}`);
    return runJob("ml-train", cfg, "jrabot-batch", args, { detach: false, timeoutSec: 6 * 3600 }).code;
  }
  if (!BATCH_TASKS.has(task)) throw new HostError("許されていない task");
  for (const a of args) if (!BATCH_ARG.test(a)) throw new HostError(`許されていない引数: ${a.slice(0, 40)}`);
  return botTask(cfg, task, args, { container: "jrabot-batch", kind: "batch", timeoutSec: 6 * 3600 }).code;
}

async function deploy(cfg: HostConfig): Promise<void> {
  // 開催日の処理の最中は入れ替えない（ingest・dashboard を作り直すので、取得と通知が途切れる）
  if (containerState("jrabot-botrun") === "running") throw new HostError("開催日の処理（bot-run）の最中は deploy しない");
  if (containerState("jrabot-mysql") === "running") await backup(cfg, "pre-deploy");
  const prev = existsSync(RELEASE_FILE) ? readFileSync(RELEASE_FILE, "utf8") : undefined;
  const recreate = (): void => {
    for (const s of ["caddy", "oauth2-proxy", "dashboard", "ingest"] as const)
      run(["docker", "rm", "--force", `jrabot-${s}`], { timeoutSec: 60 });
  };
  rmSync(join(RUN, "prepared"), { force: true }); // 入れ替えの間は tick にアプリを起動させない
  try {
    // boot が候補の digest で環境を作り直す。未適用のマイグレーションがあれば、deploy のときだけ適用する（起動時には適用しない）
    await boot(cfg, CANDIDATE_KEY).catch(async (e: unknown) => {
      if (!(e instanceof HostError) || !e.message.includes("未適用")) throw e;
      const m = runJob("db-migration", cfg, "jrabot-dbm-migrate", ["--mode=migrate"], { detach: false, timeoutSec: 1800 });
      if (m.code !== 0) throw new HostError(`migrate が失敗（${m.code}）`);
      await boot(cfg, CANDIDATE_KEY);
    });
  } catch (e) {
    if (prev !== undefined) {
      writeAtomic(RELEASE_FILE, prev, 0o644);
      recreate();
      // 前の版で準備し直す（migrate が成功して DB だけ進んだ場合は、前の版の validate が失敗して止まったままになる: 手順書の『deploy の失敗』）
      await boot(cfg).catch((b: unknown) => console.log(`前の版の準備が失敗: ${errorMessage(b).slice(0, 200)}`));
    }
    throw new HostError(`deploy が失敗し、前の版に戻した（DB は前進のみ。戻さない）: ${errorMessage(e).slice(0, 200)}`);
  }
  // 成功: 候補を正式な版に昇格（次の起動もこの版）。前の版は release-previous.json に残す（手順書の切戻し）
  const s3 = new S3Json(clients.s3(), cfg.state_bucket);
  if (prev !== undefined) await s3.put("control/release-previous.json", prev, "application/json", "no-store");
  await s3.put(RELEASE_KEY, readFileSync(RELEASE_FILE, "utf8"), "application/json", "no-store");
  recreate(); // 次の tick が新しいイメージで起動する
}

export async function main(argv: readonly string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { values } = parseArgs({
    args: [...rest],
    strict: false,
    options: { key: { type: "string" }, confirm: { type: "string" }, reason: { type: "string" }, task: { type: "string" } },
  });
  try {
    const cfg = config();
    switch (cmd) {
      case "boot":
        await boot(cfg);
        return 0;
      case "tick":
        await tick(cfg);
        return 0;
      case "backup":
        await backup(cfg, typeof values.reason === "string" ? values.reason : "manual");
        return 0;
      case "restore":
        await restore(cfg, String(values.key ?? ""), String(values.confirm ?? ""));
        return 0;
      case "deploy":
        await deploy(cfg);
        return 0;
      case "run-batch":
        return await runBatch(
          cfg,
          String(values.task ?? ""),
          rest.filter((a) => !a.startsWith("--task")),
        );
      default:
        console.error("使い方: jrabot-host boot|tick|backup|restore|deploy|run-batch");
        return 2;
    }
  } catch (e) {
    console.error(errorMessage(e).slice(0, 500));
    return 1;
  }
}

if (process.env["JRABOT_HOSTCTL"] === "1") {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
