/**
 * AWS SDK v3 のアダプタ（Lambda・ホスト・ops CLI が共用）。判断は持たない（controller.ts・host.ts）。
 * 資格情報はすべて実行環境の短期のもの（Lambda の実行ロール・EC2 のインスタンスプロファイル・GitHub Actions の OIDC）。長期キーを受け取らない。
 * 例外のメッセージにオブジェクトの内容・資格情報を入れない（種類と HTTP ステータスだけ）。
 */
import { DescribeInstancesCommand, EC2Client, StartInstancesCommand, StopInstancesCommand } from "@aws-sdk/client-ec2";
import { ChangeResourceRecordSetsCommand, Route53Client } from "@aws-sdk/client-route-53";
import { GetObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { ConflictError, UnknownOutcomeError } from "../ports.js";
import type { InstanceInfo } from "./model.js";

export const REGION = "ap-northeast-1";

function status(e: unknown): number | undefined {
  if (e instanceof S3ServiceException) return e.$metadata.httpStatusCode;
  if (typeof e === "object" && e !== null && "$metadata" in e) {
    const m = (e as { $metadata?: { httpStatusCode?: number } }).$metadata;
    return m?.httpStatusCode;
  }
  return undefined;
}

/** S3 のオブジェクト（JSON）の読み書き。条件付きの書込み（ETag の If-Match・新規は If-None-Match）で CAS にする。 */
export class S3Json {
  constructor(
    readonly s3: S3Client,
    readonly bucket: string,
  ) {}

  /** (内容, ETag)。無ければ undefined。 */
  async read(key: string, maxBytes = 1 << 20): Promise<{ raw: unknown; etag: string } | undefined> {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const text = (await r.Body?.transformToString("utf-8")) ?? "";
      if (text.length > maxBytes) throw new Error(`オブジェクトが大きすぎる: ${key}`);
      return { raw: JSON.parse(text) as unknown, etag: r.ETag ?? "" };
    } catch (e) {
      if (status(e) === 404) return undefined;
      throw e;
    }
  }

  /** etag が undefined なら新規（無いときだけ作る）。競合は ConflictError、結果不明は UnknownOutcomeError。新しい ETag を返す。 */
  async write(key: string, value: unknown, etag: string | undefined, extra: { cacheControl?: string } = {}): Promise<string> {
    try {
      const r = await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: `${JSON.stringify(value, null, 1)}\n`,
          ContentType: "application/json",
          ...(extra.cacheControl === undefined ? {} : { CacheControl: extra.cacheControl }),
          ...(etag === undefined ? { IfNoneMatch: "*" } : { IfMatch: etag }),
        }),
      );
      return r.ETag ?? "";
    } catch (e) {
      const code = status(e);
      if (code === 412 || code === 409) throw new ConflictError(`条件付きの書込みが競合した（HTTP ${code}）: ${key}`);
      if (code === undefined || code >= 500) throw new UnknownOutcomeError(`書込みの結果が不明（${code ?? "通信"}）: ${key}`);
      throw e;
    }
  }

  /** 条件なしの書込み（ビーコン・ホストの報告など、書き手が 1 人のもの）。 */
  async put(key: string, body: string | Uint8Array, contentType: string, cacheControl?: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(cacheControl === undefined ? {} : { CacheControl: cacheControl }),
      }),
    );
  }
}

export class Ec2 {
  constructor(
    readonly ec2: EC2Client,
    readonly instanceId: string,
  ) {}

  async describe(): Promise<InstanceInfo> {
    const r = await this.ec2.send(new DescribeInstancesCommand({ InstanceIds: [this.instanceId] }));
    const inst = r.Reservations?.[0]?.Instances?.[0];
    const name = inst?.State?.Name;
    const known = ["pending", "running", "stopping", "stopped", "shutting-down", "terminated"] as const;
    const state = known.find((k) => k === name) ?? "unknown";
    return { state, publicIp: inst?.PublicIpAddress };
  }

  async start(): Promise<void> {
    await this.ec2.send(new StartInstancesCommand({ InstanceIds: [this.instanceId] }));
  }

  async stop(force: boolean): Promise<void> {
    await this.ec2.send(new StopInstancesCommand({ InstanceIds: [this.instanceId], Force: force }));
  }
}

/** Route 53 の A レコード（公開 IP は起動のたびに変わる。TTL 60 秒）。 */
export async function upsertA(r53: Route53Client, zoneId: string, name: string, ip: string): Promise<void> {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error("IPv4 の形式ではない");
  await r53.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: zoneId,
      ChangeBatch: {
        Comment: "jra-bot controller",
        Changes: [{ Action: "UPSERT", ResourceRecordSet: { Name: name, Type: "A", TTL: 60, ResourceRecords: [{ Value: ip }] } }],
      },
    }),
  );
}

/** SSM の SecureString（値はログに出さない）。無ければ undefined。 */
export async function secureParameter(ssm: SSMClient, name: string): Promise<string | undefined> {
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    return r.Parameter?.Value;
  } catch (e) {
    if (typeof e === "object" && e !== null && "name" in e && e.name === "ParameterNotFound") return undefined;
    throw e;
  }
}

/** Discord の運用通知（宛先は SSM の SecureString。URL・応答の本文はログに出さない）。未設定・失敗は例外（呼び出し側が errors に記録する）。 */
export async function notifyDiscord(webhook: string | undefined, title: string, body: string): Promise<void> {
  if (webhook === undefined) throw new Error("通知の Webhook が未設定");
  if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(webhook))
    throw new Error("通知の Webhook の形式が不正");
  let status: number;
  try {
    const r = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `**[jra-bot AWS] ${title}**\n${body}`.slice(0, 1900), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    status = r.status;
  } catch {
    throw new Error("通知の送信が失敗（通信）");
  }
  if (status < 200 || status >= 300) throw new Error(`通知の送信が失敗（HTTP ${status}）`);
}

export const clients = {
  s3: (): S3Client => new S3Client({ region: REGION }),
  ec2: (): EC2Client => new EC2Client({ region: REGION }),
  route53: (): Route53Client => new Route53Client({ region: REGION }),
  ssm: (): SSMClient => new SSMClient({ region: REGION }),
};
