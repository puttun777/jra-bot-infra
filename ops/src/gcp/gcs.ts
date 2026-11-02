/**
 * GCS の ops-state（CAS = ifGenerationMatch）とビーコン。旧 GcsStateStore / GcsBeaconStore の移植。**実 GCS では未検証**（G-OPS-*）。
 * Cloud Storage JSON API を直接呼ぶ（依存を増やさない）。アクセストークンは実行環境の gcloud（GitHub Actions は WIF）から取る。
 * - generation は int64 の**文字列**で返るので bigint に変換する（number にしない）。
 * - 書込みの応答: 200 = 成立、412 = ConflictError（自分の前回の書込みかもしれないので呼出側が再読取りで確認）、
 *   通信の失敗・タイムアウト・429・5xx = UnknownOutcomeError（成立したか不明）、それ以外 = 失敗。
 */
import { randomBytes } from "node:crypto";
import { isRecord, parseJson } from "../json.js";
import { type BeaconStore, ConflictError, type Generation, type StateStore, UnknownOutcomeError } from "../ports.js";
import type { Runner } from "./gcloud.js";

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Buffer; signal?: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export class GcsError extends Error {
  override readonly name = "GcsError";
}

const API = "https://storage.googleapis.com";

export function parseGeneration(v: unknown): Generation {
  if (typeof v !== "string" || !/^\d{1,20}$/.test(v)) throw new GcsError(`generation が不正: ${String(v)}`);
  return BigInt(v);
}

/** gcloud から取るアクセストークン（5 分キャッシュ）。値はログに出さない。 */
export function gcloudToken(run: Runner): () => Promise<string> {
  let cached: { token: string; at: number } | undefined;
  return async () => {
    if (cached !== undefined && Date.now() - cached.at < 5 * 60_000) return cached.token;
    const { code, out } = await run(["gcloud", "auth", "print-access-token"]);
    if (code !== 0 || out.trim() === "") throw new GcsError("アクセストークンを取得できない");
    cached = { token: out.trim(), at: Date.now() };
    return cached.token;
  };
}

/** キーを辞書順に並べた JSON（人が読みやすいよう indent 1）。内容の一致判定は呼出側が正準形で行う。 */
function sortedJson(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (isRecord(x))
      return Object.fromEntries(
        Object.keys(x)
          .sort()
          .map((k) => [k, sort(x[k])]),
      );
    return x;
  };
  return JSON.stringify(sort(v), null, 1);
}

export class GcsClient {
  constructor(
    private readonly fetchFn: Fetch,
    private readonly token: () => Promise<string>,
    /** 1 回のリクエストの上限（ミリ秒）。**中断（SIGINT/SIGTERM）の signal は渡さない**: 中断の後にリースの解放と FAILED の記録を書くため */
    private readonly timeoutMs = 30_000,
  ) {}

  private async req(method: string, url: string, headers: Record<string, string> = {}, body?: Buffer) {
    const h = { Authorization: `Bearer ${await this.token()}`, ...headers };
    const init: { method: string; headers: Record<string, string>; body?: Buffer; signal?: AbortSignal } = { method, headers: h };
    if (body !== undefined) init.body = body;
    init.signal = AbortSignal.timeout(this.timeoutMs);
    return this.fetchFn(url, init);
  }

  /** 内容と generation。無ければ undefined。 */
  async read(bucket: string, name: string): Promise<{ body: string; generation: Generation } | undefined> {
    const url = `${API}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}?alt=media`;
    for (let attempt = 1; ; attempt++) {
      let r: Awaited<ReturnType<Fetch>>;
      try {
        r = await this.req("GET", url);
      } catch (e) {
        if (attempt >= 3) throw new GcsError(`GCS の読取りに失敗: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (r.status === 404) return undefined;
      if ((r.status === 408 || r.status === 429 || r.status >= 500) && attempt < 3) continue;
      if (r.status !== 200) throw new GcsError(`GCS の読取りが HTTP ${r.status}`);
      return { body: await r.text(), generation: parseGeneration(r.headers.get("x-goog-generation")) };
    }
  }

  /** multipart で書く（Cache-Control を付けられる）。ifGeneration=0n は『無いときだけ作る』。 */
  async write(bucket: string, name: string, data: Buffer, opts: { ifGeneration?: Generation; cacheControl?: string }): Promise<Generation> {
    const q = new URLSearchParams({ uploadType: "multipart" });
    if (opts.ifGeneration !== undefined) q.set("ifGenerationMatch", opts.ifGeneration.toString());
    const boundary = `jrabot-${randomBytes(12).toString("hex")}`;
    const meta: Record<string, string> = { name, contentType: "application/json" };
    if (opts.cacheControl !== undefined) meta["cacheControl"] = opts.cacheControl;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    let r: Awaited<ReturnType<Fetch>>;
    try {
      r = await this.req(
        "POST",
        `${API}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?${q.toString()}`,
        { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      );
    } catch (e) {
      throw new UnknownOutcomeError(`GCS への書込みの結果が不明（通信の失敗）: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (r.status === 412) throw new ConflictError("412 Precondition Failed");
    if (r.status === 408 || r.status === 429 || r.status >= 500)
      throw new UnknownOutcomeError(`GCS への書込みの結果が不明（HTTP ${r.status}）`);
    if (r.status !== 200) throw new GcsError(`GCS への書込みが HTTP ${r.status}`);
    // 200 の後の本文の読取り・解析の失敗は『成立したかもしれない』（結果不明）として扱い、呼出側の再読取りで確かめる
    try {
      const res = parseJson(await r.text(), "GCS の応答");
      if (!isRecord(res)) throw new GcsError("GCS の応答が不正");
      return parseGeneration(res["generation"]);
    } catch (e) {
      throw new UnknownOutcomeError(`GCS への書込みは 200 だが応答を読めない: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export class GcsStateStore implements StateStore {
  static readonly STATE = "state/ops-state.json";

  constructor(
    private readonly gcs: GcsClient,
    private readonly bucket: string,
  ) {}

  async read(): Promise<{ raw: unknown; generation: Generation }> {
    const r = await this.gcs.read(this.bucket, GcsStateStore.STATE);
    if (r === undefined) return { raw: undefined, generation: 0n };
    return { raw: parseJson(r.body, "ops-state.json"), generation: r.generation };
  }

  async write(state: unknown, ifGeneration: Generation): Promise<Generation> {
    return this.gcs.write(this.bucket, GcsStateStore.STATE, Buffer.from(sortedJson(state), "utf8"), { ifGeneration });
  }

  async appendHistory(name: string, state: unknown): Promise<void> {
    await this.gcs.write(this.bucket, `history/${name}.json`, Buffer.from(sortedJson(state), "utf8"), { ifGeneration: 0n });
  }
}

export class GcsBeaconStore implements BeaconStore {
  static readonly OBJECT = "beacon/mode.json";

  constructor(
    private readonly gcs: GcsClient,
    private readonly bucket: string,
  ) {}

  async write(raw: Buffer): Promise<void> {
    await this.gcs.write(this.bucket, GcsBeaconStore.OBJECT, raw, { cacheControl: "no-store" });
  }
}
