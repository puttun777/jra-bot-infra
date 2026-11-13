/**
 * GitHub Actions（本人の手動実行。スマホのブラウザからも実行できる）から呼ぶ AWS の運用 CLI。
 *
 *   aws view --minutes 60 [--wait]          閲覧用の起動（bot・通知・重い処理は始めない）。--wait で準備完了と接続先を待つ
 *   aws view-end                            閲覧の終了（この実行より後に延長した閲覧は止めない）
 *   aws status                              状態（EC2・アプリの準備・起動目的・bot・自動停止の予定・バックアップ）
 *   aws raceday-add --date D [--first-post T --last-post T] / raceday-skip --date D --reason R
 *   aws batch --minutes N --reason R [--wait]   重い処理の起動（開催日の処理中は拒否）
 *   aws run-batch --task backtest --args "--from=… --to=…"   batch の起動中に重い処理を実行（SSM）
 *   aws stop-all --reason R                 すべての hold を外して止める（今日の開催日も自動で再起動しない）
 *   aws deploy --manifest F --schema S [--arch arm64]   release-manifest（workflow が取得し SHA-256 を確認したもの）のイメージに入れ替える
 *   aws backup --reason R / aws secrets-init
 *
 * 認証: GitHub の OIDC → STS（AssumeRoleWithWebIdentity）の短期の資格情報だけ（長期キーなし。ロールは infra の Pulumi が作る）。
 * 資格情報・秘密は出力しない。終了コード: 0 成功 / 1 失敗・拒否 / 2 引数の誤り。
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetCommandInvocationCommand, PutParameterCommand, SendCommandCommand, SSMClient } from "@aws-sdk/client-ssm";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import { CONTRACT_MAJOR_MINOR, compareVersions, loadJson } from "../deploy.js";
import { errorMessage } from "../json.js";
import { REGION } from "./adapters.js";
import { HOST_IMAGE_PATTERNS } from "./services.js";

export class CliError extends Error {
  override readonly name = "CliError";
  constructor(
    message: string,
    readonly code: 1 | 2 = 1,
  ) {
    super(message);
  }
}

interface Creds {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
}

/** GitHub の OIDC → STS（署名不要の呼び出し）。 */
export async function githubCredentials(roleArn: string, env: NodeJS.ProcessEnv, fetchFn: typeof fetch = fetch): Promise<Creds> {
  if (!/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_-]{1,64}$/.test(roleArn)) throw new CliError("AWS_ROLE_ARN の形式が不正", 2);
  const url = env["ACTIONS_ID_TOKEN_REQUEST_URL"];
  const token = env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  if (!url || !token) throw new CliError("OIDC のトークンを要求できない（permissions: id-token: write が必要）", 2);
  const u = new URL(url);
  u.searchParams.set("audience", "sts.amazonaws.com");
  const o = await fetchFn(u, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  const oidc = z.object({ value: z.string().min(10) }).parse(await o.json()).value;
  const body = new URLSearchParams({
    Action: "AssumeRoleWithWebIdentity",
    Version: "2011-06-15",
    RoleArn: roleArn,
    RoleSessionName: `gha-${env["GITHUB_RUN_ID"] ?? "local"}`.slice(0, 64),
    WebIdentityToken: oidc,
    DurationSeconds: "3600",
  });
  const r = await fetchFn(`https://sts.${REGION}.amazonaws.com/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const xml = await r.text();
  if (r.status !== 200) throw new CliError(`STS が失敗（HTTP ${r.status}）`);
  const v = (tag: string): string => {
    const m = new RegExp(`<${tag}>([^<]{1,4096})</${tag}>`).exec(xml);
    if (m?.[1] === undefined) throw new CliError(`STS の応答に ${tag} が無い`);
    return m[1];
  };
  return { accessKeyId: v("AccessKeyId"), secretAccessKey: v("SecretAccessKey"), sessionToken: v("SessionToken") };
}

async function invoke(lambda: LambdaClient, fn: string, payload: unknown): Promise<Record<string, unknown>> {
  const r = await lambda.send(new InvokeCommand({ FunctionName: fn, Payload: Buffer.from(JSON.stringify(payload)) }));
  const text = Buffer.from(r.Payload ?? new Uint8Array()).toString("utf8");
  if (r.FunctionError !== undefined) throw new CliError(`制御の Lambda が失敗: ${text.slice(0, 300)}`);
  return z.record(z.string(), z.unknown()).parse(JSON.parse(text));
}

/** 状態の表示（Markdown。GitHub の実行の要約・スマホで読む）。秘密は無い。 */
export function render(result: Record<string, unknown>): string {
  const s = (result["summary"] ?? {}) as Record<string, unknown>;
  const holds = Array.isArray(s["holds"]) ? (s["holds"] as Record<string, unknown>[]) : [];
  const host = (s["host"] ?? null) as Record<string, unknown> | null;
  const lines = [
    `### jra-bot（AWS）: ${String(result["message"] ?? "") || "状態"}`,
    "",
    `- 運用モード: **${String(s["mode"] ?? "?")}** ／ EC2: ${String(s["ec2"] ?? "?")} ／ 利用可能: **${s["usable"] === true ? "はい" : "いいえ"}**`,
    `- 接続先: ${s["url"] === null || s["url"] === undefined ? "（準備完了まで表示しない）" : String(s["url"])}`,
    `- 起動目的: ${holds.length === 0 ? "なし（停止へ）" : holds.map((h) => `${String(h["purpose"])}${h["race_date"] === null ? "" : `(${String(h["race_date"])})`} 〜${String(h["expires_at"])}`).join("、")}`,
    `- 自動停止の予定: ${String(s["auto_stop_at"] ?? "—")}（UTC）`,
    `- 許された処理: ${JSON.stringify(s["workloads"] ?? {})}`,
  ];
  if (host !== null) {
    lines.push(
      `- ホスト: ${String(host["phase"])}（${String(host["reported_at"])}） ready=${JSON.stringify(host["ready"])} bot_run=${JSON.stringify(host["bot_run"])}`,
    );
    lines.push(`- バックアップ: ${JSON.stringify(host["backup"])}`);
  }
  if (s["last_stop"] !== null && s["last_stop"] !== undefined) lines.push(`- 最後の停止: ${JSON.stringify(s["last_stop"])}`);
  const pk = result["beaconPublicKey"] as Record<string, unknown> | undefined;
  if (pk !== undefined) lines.push(`- ビーコンの検証鍵（公開値。エージェントの設定）: kid=${String(pk["kid"])} key=${String(pk["key"])}`);
  const errors = Array.isArray(result["errors"]) ? (result["errors"] as unknown[]) : [];
  if (errors.length > 0) lines.push(`- 次の実行で再試行する操作: ${errors.map(String).join(" / ").slice(0, 400)}`);
  return `${lines.join("\n")}\n`;
}

async function waitUsable(
  lambda: LambdaClient,
  fn: string,
  minutes: number,
  sleep: (ms: number) => Promise<void>,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + minutes * 60_000;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    last = await invoke(lambda, fn, { action: "status" });
    if ((last["summary"] as Record<string, unknown> | undefined)?.["usable"] === true) return last;
    await sleep(20_000);
  }
  return last;
}

const SECRET_NAMES = [
  "mysql-root",
  "db-migrate",
  "db-app",
  "db-ingest",
  "db-bot",
  "db-mltrain",
  "ingest-token-pepper",
  "oauth2-cookie-secret",
] as const;

/** 乱数の秘密を SSM の SecureString に作る（**既にあるものは上書きしない**。値は出力しない）。ビーコン・モデルの署名鍵も作る。 */
async function secretsInit(ssm: SSMClient, prefix: string): Promise<string[]> {
  const created: string[] = [];
  // 値を読まずに「無いときだけ作る」（Overwrite=false。既にあれば ParameterAlreadyExists）。GitHub のロールに GetParameter を渡さない
  const put = async (name: string, value: string): Promise<void> => {
    try {
      await ssm.send(new PutParameterCommand({ Name: `${prefix}/${name}`, Value: value, Type: "SecureString", Overwrite: false }));
      created.push(name);
    } catch (e) {
      if (!(typeof e === "object" && e !== null && "name" in e && (e as { name: string }).name === "ParameterAlreadyExists")) throw e;
    }
  };
  for (const n of SECRET_NAMES)
    await put(n, randomBytes(n === "oauth2-cookie-secret" ? 32 : 30).toString(n === "oauth2-cookie-secret" ? "base64" : "base64url"));
  await put("agent-kek-keys", `k1:${randomBytes(32).toString("base64")}`);
  const ed = (): string =>
    generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64");
  await put("beacon/signing-key", ed());
  await put("model-signing-key", ed());
  return created;
}

/** ホストで許したコマンドだけを実行する（SSM の専用ドキュメント。任意のシェルは送れない: infra の Pulumi の host-command）。 */
export const HOST_ACTIONS = ["deploy", "backup", "run-batch"] as const;
export const HOST_ARGS = /^[A-Za-z0-9=.,_:/ -]{0,600}$/;

async function ssmRun(
  ssm: SSMClient,
  instanceId: string,
  document: string,
  action: (typeof HOST_ACTIONS)[number],
  args: string,
  timeoutMin: number,
): Promise<{ status: string; out: string }> {
  if (!HOST_ARGS.test(args)) throw new CliError("ホストのコマンドの引数に使えない文字がある", 2);
  let id: string | undefined;
  // 起動の直後は SSM のエージェントが登録されておらず InvalidInstanceId になる。5 分まで待つ
  for (let i = 0; i < 20 && id === undefined; i++) {
    try {
      const sent = await ssm.send(
        new SendCommandCommand({
          InstanceIds: [instanceId],
          DocumentName: document,
          Parameters: { action: [action], args: [args], executionTimeout: [String(timeoutMin * 60)] },
          TimeoutSeconds: 600,
        }),
      );
      id = sent.Command?.CommandId;
    } catch (e) {
      if (!(typeof e === "object" && e !== null && "name" in e && (e as { name: string }).name === "InvalidInstanceId")) throw e;
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
  if (id === undefined) throw new CliError("SSM のコマンドを送れない");
  const deadline = Date.now() + (timeoutMin + 2) * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));
    try {
      const inv = await ssm.send(new GetCommandInvocationCommand({ CommandId: id, InstanceId: instanceId }));
      if (inv.Status !== undefined && !["Pending", "InProgress", "Delayed"].includes(inv.Status)) {
        return { status: inv.Status, out: `${inv.StandardOutputContent ?? ""}\n${inv.StandardErrorContent ?? ""}`.slice(-3000) };
      }
    } catch {
      // 登録の直後は InvocationDoesNotExist になることがある
    }
  }
  return { status: "TimedOut", out: "" };
}

/** サードパーティのイメージ（Pulumi の出力 host_images を GitHub の環境変数 HOST_IMAGES に置く。tag と digest の両方で固定。ホストも同じ規則で検査する）。 */
export const HostImagesSchema = z
  .object({
    mysql: z.string().regex(HOST_IMAGE_PATTERNS.mysql),
    caddy: z.string().regex(HOST_IMAGE_PATTERNS.caddy),
    "oauth2-proxy": z.string().regex(HOST_IMAGE_PATTERNS.oauth2Proxy),
  })
  .strict();
export type HostImagesInput = z.infer<typeof HostImagesSchema>;

export function parseHostImages(text: string): HostImagesInput {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CliError("HOST_IMAGES が JSON ではない", 2);
  }
  const r = HostImagesSchema.safeParse(raw);
  if (!r.success) throw new CliError("HOST_IMAGES は mysql・caddy・oauth2-proxy を tag@sha256 で固定する（docs/AWS_OPERATIONS.md）", 2);
  return r.data;
}

/** deploy が使う部分（JSON Schema の検証の後に取り出す）。 */
const ManifestSchema = z.looseObject({
  schema_version: z.literal(3),
  release: z.string(),
  git_sha: z.string().regex(/^[0-9a-f]{40}$/),
  contract_version: z.string(),
  required_schema_version: z.string(),
  flyway: z.looseObject({ latest_version: z.string() }),
  rollback: z.looseObject({ min_app_release: z.string() }),
  images: z
    .record(z.string(), z.string().regex(/^\d{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com\/jra-bot\/[a-z-]+@sha256:[0-9a-f]{64}$/))
    .refine((m) => ["dashboard", "ingest", "bot", "db-migration", "ml-train"].every((k) => k in m), "images が足りない"),
  runtime: z.looseObject({ arch: z.enum(["arm64", "amd64"]).optional() }),
});

/** release-manifest（ECR のイメージ）に host_images を足した、ホストが読む版（control/release-candidate.json）。 */
export function buildRelease(
  manifest: unknown,
  schema: unknown,
  hostImages: HostImagesInput,
  arch: string,
): z.infer<typeof ManifestSchema> & { host_images: HostImagesInput } {
  if (typeof schema !== "object" || schema === null) throw new CliError("スキーマがオブジェクトではない", 2);
  const validate = new Ajv2020({ strict: true, allErrors: true, validateFormats: false }).compile(schema);
  if (!validate(manifest))
    throw new CliError(
      `release-manifest がスキーマに合わない: ${(validate.errors ?? [])
        .slice(0, 3)
        .map((e) => `${e.instancePath} ${e.message ?? e.keyword}`)
        .join(" / ")}`,
    );
  if (
    typeof manifest === "object" &&
    manifest !== null &&
    ("kind" in manifest || (manifest as { deployable?: unknown }).deployable === false)
  )
    throw new CliError("プレビュー manifest は deploy に使えない");
  const r = ManifestSchema.safeParse(manifest);
  if (!r.success) throw new CliError("release-manifest が AWS 向けではない（ECR のイメージ・schema v3）");
  const m = r.data;
  if (arch !== "arm64" && arch !== "amd64") throw new CliError("--arch は arm64 か amd64", 2);
  if (m.runtime.arch === undefined) throw new CliError("manifest に runtime.arch が無い（AWS 向けの release で作る）");
  if (m.runtime.arch !== arch) throw new CliError(`イメージの CPU（${m.runtime.arch}）とインスタンス（${arch}）が一致しない`);
  if (!m.contract_version.startsWith(`${CONTRACT_MAJOR_MINOR}.`))
    throw new CliError(`contract_version ${m.contract_version} は deploy が対応する ${CONTRACT_MAJOR_MINOR}.x ではない`);
  if (compareVersions(m.rollback.min_app_release, m.release) > 0)
    throw new CliError("rollback.min_app_release が release より新しい（契約違反）");
  if (compareVersions(m.required_schema_version, m.flyway.latest_version) > 0)
    throw new CliError("required_schema_version が flyway.latest_version より新しい");
  return { ...m, host_images: hostImages };
}

/** EC2 が running で、運用モードが起動の側（STARTING・NORMAL）になるまで待つ（停止の途中の排出・電源断に重ねない）。 */
async function waitRunning(lambda: LambdaClient, fn: string, minutes: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const deadline = Date.now() + minutes * 60_000;
  while (Date.now() < deadline) {
    const s = (await invoke(lambda, fn, { action: "status" }))["summary"] as Record<string, unknown> | undefined;
    if (s?.["ec2"] === "running" && (s["mode"] === "STARTING" || s["mode"] === "NORMAL")) return true;
    await sleep(15_000);
  }
  return false;
}

/**
 * 本人が要求した時刻 = GitHub の実行の作成時刻（runner の待ちで要求の順序が逆転しないように）。取れなければ今の時刻。
 * 閲覧の延長と閲覧の終了・全停止の前後の比較に使う（controller.applyRequest）。
 */
export async function dispatchedAt(env: NodeJS.ProcessEnv, fetchFn: typeof fetch = fetch): Promise<string> {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const id = env["GITHUB_RUN_ID"];
  const repo = env["GITHUB_REPOSITORY"];
  const token = env["GITHUB_TOKEN"];
  const api = env["GITHUB_API_URL"] ?? "https://api.github.com";
  if (!id || !repo || !token || !/^\d{1,20}$/.test(id) || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^https:\/\/[\w.-]+(\/[\w./-]*)?$/.test(api))
    return now;
  try {
    const r = await fetchFn(`${api}/repos/${repo}/actions/runs/${id}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status !== 200) return now;
    const created = z.object({ created_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/) }).safeParse(await r.json());
    return created.success && created.data.created_at <= now ? created.data.created_at : now;
  } catch {
    return now;
  }
}

/** GitHub Actions の step の出力（GITHUB_OUTPUT）。値は検査したものだけ（改行で別の出力を作らせない）。 */
export function emitOutput(env: NodeJS.ProcessEnv, key: string, value: string): void {
  const file = env["GITHUB_OUTPUT"];
  if (file === undefined || file === "" || !/^[a-z0-9-]{4,64}$/.test(value)) return;
  appendFileSync(file, `${key}=${value}\n`);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    const { values: a } = parseArgs({
      args: [...rest],
      strict: true,
      options: {
        minutes: { type: "string" },
        reason: { type: "string", default: "" },
        date: { type: "string" },
        "first-post": { type: "string" },
        "last-post": { type: "string" },
        hold: { type: "string" },
        task: { type: "string" },
        args: { type: "string", default: "" },
        wait: { type: "boolean", default: false },
        manifest: { type: "string" },
        schema: { type: "string" },
        arch: { type: "string", default: "arm64" },
      },
    });
    const need = (k: string): string => {
      const v = env[k];
      if (v === undefined || v === "") throw new CliError(`環境変数 ${k} が未設定（環境 ops の変数）`, 2);
      return v;
    };
    const creds = await githubCredentials(need("AWS_ROLE_ARN"), env);
    const lambda = new LambdaClient({ region: REGION, credentials: creds });
    const fn = need("CONTROLLER_FUNCTION");
    const actor = `github:${env["GITHUB_ACTOR"] ?? "unknown"}`;
    const minutes = (def: number): number => {
      const n = Number(a.minutes ?? def);
      if (!Number.isInteger(n)) throw new CliError("--minutes は整数", 2);
      return n;
    };
    const out = (r: Record<string, unknown>): number => {
      console.log(render(r));
      return r["ok"] === false ? 1 : 0;
    };
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    switch (cmd) {
      case "status":
        return out(await invoke(lambda, fn, { action: "status" }));
      case "view": {
        const r = await invoke(lambda, fn, {
          action: "view",
          minutes: minutes(60),
          actor,
          reason: a.reason || "閲覧",
          requested_at: await dispatchedAt(env),
        });
        console.log(render(r));
        if (r["ok"] === false || !a.wait) return r["ok"] === false ? 1 : 0;
        const ready = await waitUsable(lambda, fn, 15, sleep);
        return out({
          ...ready,
          message:
            (ready["summary"] as Record<string, unknown> | undefined)?.["usable"] === true
              ? "利用できます"
              : "15 分で準備が完了しなかった（status で確認）",
        });
      }
      case "view-end":
        return out(await invoke(lambda, fn, { action: "view-end", actor, requested_at: await dispatchedAt(env) }));
      case "batch": {
        if (a.reason === "") throw new CliError("--reason が必要", 2);
        const r = await invoke(lambda, fn, { action: "batch", minutes: minutes(180), actor, reason: a.reason });
        // workflow の後片付け（自分の hold だけを外す）のために hold の ID を出力する
        if (typeof r["holdId"] === "string") emitOutput(env, "hold_id", r["holdId"]);
        if (r["ok"] !== false && a.wait) {
          const ready = await waitUsable(lambda, fn, 15, sleep);
          console.log(render(ready));
          return (ready["summary"] as Record<string, unknown> | undefined)?.["usable"] === true ? 0 : 1;
        }
        return out(r);
      }
      case "release":
        return out(await invoke(lambda, fn, { action: "release", hold_id: a.hold ?? "", actor }));
      case "raceday-add": {
        if (a.date === undefined || !DATE.test(a.date)) throw new CliError("--date は YYYY-MM-DD", 2);
        for (const t of [a["first-post"], a["last-post"]])
          if (t !== undefined && t !== "" && !TS.test(t)) throw new CliError("発走時刻は UTC の YYYY-MM-DDTHH:MM:SSZ", 2);
        return out(
          await invoke(lambda, fn, {
            action: "raceday-add",
            date: a.date,
            first_post: a["first-post"] || null,
            last_post: a["last-post"] || null,
            actor,
          }),
        );
      }
      case "raceday-skip":
        if (a.date === undefined || !DATE.test(a.date) || a.reason === "") throw new CliError("--date と --reason が必要", 2);
        return out(await invoke(lambda, fn, { action: "raceday-skip", date: a.date, actor, reason: a.reason }));
      case "stop-all":
        if (a.reason === "") throw new CliError("--reason が必要", 2);
        return out(
          await invoke(lambda, fn, {
            action: "stop-all",
            actor,
            reason: a.reason,
            requested_at: await dispatchedAt(env),
          }),
        );
      case "secrets-init": {
        const created = await secretsInit(new SSMClient({ region: REGION, credentials: creds }), need("SSM_PREFIX"));
        console.log(`作成した秘密: ${created.length === 0 ? "なし（すべて既にある）" : created.join(", ")}（値は表示しない）`);
        return 0;
      }
      case "run-batch": {
        const task = a.task ?? "";
        if (!/^(backtest|export-dataset|ml-train)$/.test(task)) throw new CliError("--task は backtest・export-dataset・ml-train", 2);
        const args = a.args.split(/\s+/).filter((x) => x !== "");
        for (const x of args)
          if (!/^(--[a-z-]{2,30}=[A-Za-z0-9.,_:/-]{1,128}|train)$/.test(x)) throw new CliError(`使えない引数: ${x.slice(0, 40)}`, 2);
        const r = await ssmRun(
          new SSMClient({ region: REGION, credentials: creds }),
          need("INSTANCE_ID"),
          need("HOST_COMMAND_DOCUMENT"),
          "run-batch",
          [`--task=${task}`, ...args].join(" "),
          360,
        );
        console.log(`run-batch: ${r.status}\n\`\`\`\n${r.out}\n\`\`\``);
        return r.status === "Success" ? 0 : 1;
      }
      case "backup": {
        const r = await ssmRun(
          new SSMClient({ region: REGION, credentials: creds }),
          need("INSTANCE_ID"),
          need("HOST_COMMAND_DOCUMENT"),
          "backup",
          `--reason=${a.reason.replace(/[^a-z0-9-]/g, "").slice(0, 40) || "manual"}`,
          40,
        );
        console.log(`backup: ${r.status}\n\`\`\`\n${r.out}\n\`\`\``);
        return r.status === "Success" ? 0 : 1;
      }
      case "deploy": {
        if (a.manifest === undefined || a.schema === undefined) throw new CliError("--manifest と --schema が必要", 2);
        const hostImages = parseHostImages(need("HOST_IMAGES"));
        const candidate = buildRelease(loadJson(a.manifest), loadJson(a.schema), hostImages, a.arch);
        // 開催日の処理の最中は入れ替えない（ホストも拒否する。ここでは早めに知らせる）
        const before = await invoke(lambda, fn, { action: "status" });
        const wl = (before["summary"] as Record<string, unknown> | undefined)?.["workloads"] as Record<string, unknown> | undefined;
        if (wl?.["raceday"] === true) throw new CliError("開催日の処理の最中は deploy しない（終わってから実行する）");
        const s3 = new S3Client({ region: REGION, credentials: creds });
        await s3.send(
          new PutObjectCommand({
            Bucket: need("STATE_BUCKET"),
            Key: "control/release-candidate.json",
            Body: `${JSON.stringify(candidate, null, 1)}\n`,
            ContentType: "application/json",
          }),
        );
        const reason = `deploy ${candidate.release}`;
        const hold = await invoke(lambda, fn, { action: "maintenance", minutes: 120, actor, reason });
        if (hold["ok"] === false) return out(hold);
        const holdId = String(hold["holdId"] ?? "");
        try {
          // アプリの準備完了ではなく EC2 の起動を待つ（初回はまだ版が無いのでアプリが準備できない）。停止の途中（排出・電源断）には送らない
          if (!(await waitRunning(lambda, fn, 15, sleep))) throw new CliError("EC2 が 15 分で起動しない（status で確認）");
          const r = await ssmRun(
            new SSMClient({ region: REGION, credentials: creds }),
            need("INSTANCE_ID"),
            need("HOST_COMMAND_DOCUMENT"),
            "deploy",
            "",
            40,
          );
          console.log(`deploy: ${r.status}\n\`\`\`\n${r.out}\n\`\`\``);
          if (r.status !== "Success") return 1;
          // 準備完了を待つ間に保守の期限が切れて止まらないように延ばす
          await invoke(lambda, fn, { action: "maintenance", minutes: 30, actor, reason });
          const ready = await waitUsable(lambda, fn, 15, sleep);
          console.log(render({ ...ready, message: `deploy ${candidate.release}` }));
          return (ready["summary"] as Record<string, unknown> | undefined)?.["usable"] === true ? 0 : 1;
        } finally {
          await invoke(lambda, fn, { action: "release", hold_id: holdId, actor }).catch(() => undefined);
        }
      }
      default:
        throw new CliError(`未知のサブコマンド: ${String(cmd)}`, 2);
    }
  } catch (e) {
    if (e instanceof CliError) {
      console.error(e.message);
      return e.code;
    }
    console.error(`失敗: ${errorMessage(e).slice(0, 300)}`);
    return 1;
  }
}

if (process.argv[1]?.endsWith("aws/cli.js") === true) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
