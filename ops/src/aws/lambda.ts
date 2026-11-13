/**
 * 起動・停止・状態確認の制御（Lambda。VPC に接続しない: NAT などの固定費を作らない）。EventBridge Scheduler が 5 分ごとに `{"action":"tick"}`、
 * GitHub Actions（本人の手動実行。OIDC のロールは lambda:InvokeFunction だけ）が閲覧・延長・停止・状態確認などの要求を送る。
 *
 * 1 回の呼び出し: 運用状態・ホストの報告・開催予定・EC2・公開中のビーコンを読む → 要求を反映 → 収束（controller.reconcile）→
 * CAS で書く（競合したら読み直してやり直す。最大 4 回）→ 副作用（起動・停止・DNS・ビーコン・通知。どれも冪等）→ 要約を返す。
 * 同時に呼ばれても（定期実行と要求が重なっても）CAS が 1 つだけを通し、もう一方は新しい状態から判断し直す。
 */
import type { KeyObject } from "node:crypto";
import { z } from "zod";
import { makeBeacon, privateKeyFromSecret, publicKeyRaw } from "../beacon.js";
import { canonicalEqual, errorMessage } from "../json.js";
import { ConflictError, UnknownOutcomeError } from "../ports.js";
import * as S from "../state.js";
import { MODES, type Mode } from "../state.js";
import { clients, Ec2, notifyDiscord, S3Json, secureParameter, upsertA } from "./adapters.js";
import { applyRequest, initialAwsState, RequestRejected, reconcile, summarize } from "./controller.js";
import {
  type AwsOpsState,
  AwsOpsStateSchema,
  type CalendarPlan,
  CalendarPlanSchema,
  type ControllerConfig,
  ControllerConfigSchema,
  DEFAULT_CONFIG,
  type HostStatus,
  HostStatusSchema,
  type InstanceInfo,
  type Request,
  RequestSchema,
} from "./model.js";

/** 制御が外部に対して行う操作（試験は偽物を渡す）。 */
export interface ControllerPorts {
  readState(): Promise<{ raw: unknown; etag: string } | undefined>;
  writeState(next: AwsOpsState, etag: string | undefined): Promise<void>;
  appendHistory(name: string, state: AwsOpsState): Promise<void>;
  readHost(): Promise<unknown>;
  readPlan(): Promise<unknown>;
  readBeacon(): Promise<unknown>;
  describe(): Promise<InstanceInfo>;
  start(): Promise<void>;
  stop(force: boolean): Promise<void>;
  writeBeacon(mode: Mode, seq: number, now: string): Promise<void>;
  upsertDns(ip: string): Promise<void>;
  notify(title: string, body: string): Promise<void>;
}

export interface ControllerResult {
  readonly ok: boolean;
  readonly message: string;
  readonly holdId?: string;
  readonly summary: Record<string, unknown>;
  readonly errors: readonly string[];
  /** status のときだけ: ビーコンの検証鍵（公開値。生 32 バイトの base64url。Windows エージェントの beacon.keys に使う）。 */
  readonly beaconPublicKey?: { kid: string; key: string };
}

/** 外部から読んだ文書は検査に通らなければ「無い」として扱う（壊れたホストの報告で起動・停止を誤らない。運用状態だけは例外で止める）。 */
function safe<T>(schema: z.ZodType<T>, raw: unknown): T | undefined {
  const r = schema.safeParse(raw);
  return r.success ? r.data : undefined;
}

export async function runController(
  ports: ControllerPorts,
  request: Request,
  nowIso: string,
  cfg: ControllerConfig,
  siteUrl: string | undefined,
): Promise<ControllerResult> {
  const errors: string[] = [];
  for (let attempt = 1; attempt <= 4; attempt++) {
    const current = await ports.readState();
    // 運用状態が壊れていたら何もしない（正本を推測で書き換えない。復旧は手順書）
    const state = current === undefined ? initialAwsState(nowIso) : AwsOpsStateSchema.parse(current.raw);
    const [hostRaw, planRaw, beaconRaw, instance] = await Promise.all([
      ports.readHost(),
      ports.readPlan(),
      ports.readBeacon(),
      ports.describe(),
    ]);
    const host: HostStatus | undefined = safe(HostStatusSchema, hostRaw);
    const plan: CalendarPlan | undefined = safe(CalendarPlanSchema, planRaw);
    const published = safe(z.looseObject({ mode: z.enum(MODES) }), beaconRaw)?.mode;
    let applied: { state: AwsOpsState; message: string; holdId?: string };
    try {
      applied = applyRequest(state, request, nowIso);
    } catch (e) {
      if (e instanceof RequestRejected)
        return { ok: false, message: e.message, summary: summarize(state, host, instance, nowIso, siteUrl), errors };
      throw e;
    }
    const { state: next, effects } = reconcile(applied.state, host, instance, plan, nowIso, cfg, published);
    let committed = next;
    if (effects.beacon !== undefined)
      committed = { ...next, beacon: { seq: state.seq + 1, mode: effects.beacon, updated_at: nowIso, kid: next.beacon?.kid ?? "" } };
    const changed = current === undefined || !canonicalEqual(state, committed);
    if (changed) {
      committed = S.bump(committed) as AwsOpsState;
      // 書く前に検査する（上限を超えた状態を書くと、以後の実行がすべて読めずに失敗し、自動停止も止まる）
      const valid = AwsOpsStateSchema.safeParse(committed);
      if (!valid.success)
        return {
          ok: false,
          message: `運用状態の検査に失敗したので書かない: ${valid.error.issues[0]?.path.join(".") ?? "?"}`,
          summary: summarize(state, host, instance, nowIso, siteUrl),
          errors,
        };
      if (effects.beacon !== undefined && committed.beacon !== null && committed.beacon !== undefined) committed.beacon.seq = committed.seq;
      try {
        await ports.writeState(committed, current?.etag);
      } catch (e) {
        if (e instanceof ConflictError || e instanceof UnknownOutcomeError) {
          errors.push(`attempt ${attempt}: ${e.message}`);
          continue; // 読み直して判断し直す（結果不明の書込みも、読み直せば成立したかが分かる）
        }
        throw e;
      }
      try {
        if (committed.mode !== state.mode || request.action !== "tick")
          await ports.appendHistory(`${nowIso}-${committed.seq}-${request.action}`, committed);
      } catch {
        // 履歴は監査の補助。本体は書けている
      }
    }
    // 副作用（冪等）。失敗は記録して次の実行に任せる（状態は既に正しい）
    const run = async (label: string, f: () => Promise<void>): Promise<void> => {
      try {
        await f();
      } catch (e) {
        errors.push(`${label}: ${errorMessage(e).slice(0, 200)}`);
      }
    };
    if (effects.start) await run("start", () => ports.start());
    if (effects.stop !== "none") await run("stop", () => ports.stop(effects.stop === "force"));
    if (effects.dnsIp !== undefined) {
      const ip = effects.dnsIp;
      await run("dns", async () => {
        await ports.upsertDns(ip);
        // 記録（last_dns）は状態と一緒に書いてある。失敗しても 1 時間以内に書き直す（controller.reconcile）
      });
    }
    if (effects.beacon !== undefined) {
      const mode = effects.beacon;
      await run("beacon", () => ports.writeBeacon(mode, committed.seq, nowIso));
    }
    for (const n of effects.notify) await run("notify", () => ports.notify(n.title, n.body));
    return {
      ok: true,
      message: applied.message,
      ...(applied.holdId === undefined ? {} : { holdId: applied.holdId }),
      summary: summarize(committed, host, instance, nowIso, siteUrl),
      errors,
    };
  }
  return { ok: false, message: "運用状態の書込みが 4 回競合した（少し待って再実行する）", summary: {}, errors };
}

// ------------------------------------------------------------------ Lambda の入口

const EnvSchema = z.object({
  STATE_BUCKET: z.string().min(3),
  BEACON_BUCKET: z.string().min(3),
  INSTANCE_ID: z.string().regex(/^i-[0-9a-f]{8,17}$/),
  BEACON_KID: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/),
  BEACON_KEY_PARAM: z.string().startsWith("/"),
  DNS_ZONE_ID: z.string().optional(),
  DNS_NAME: z.string().optional(),
  SITE_URL: z.string().url().optional(),
  NOTIFY_WEBHOOK_PARAM: z.string().startsWith("/").optional(),
  CONTROLLER_CONFIG: z.string().optional(),
});

let beaconKey: KeyObject | undefined;

export async function handler(event: unknown): Promise<ControllerResult> {
  const env = EnvSchema.parse(process.env);
  const cfg =
    env.CONTROLLER_CONFIG === undefined
      ? DEFAULT_CONFIG
      : ControllerConfigSchema.parse({ ...DEFAULT_CONFIG, ...(JSON.parse(env.CONTROLLER_CONFIG) as object) });
  const request = RequestSchema.parse(event ?? { action: "tick" });
  const s3 = clients.s3();
  const state = new S3Json(s3, env.STATE_BUCKET);
  const beacon = new S3Json(s3, env.BEACON_BUCKET);
  const ec2 = new Ec2(clients.ec2(), env.INSTANCE_ID);
  const ssm = clients.ssm();
  const r53 = clients.route53();
  const ports: ControllerPorts = {
    readState: () => state.read("state/ops-state.json"),
    writeState: async (next, etag) => {
      await state.write("state/ops-state.json", next, etag);
    },
    appendHistory: async (name, st) => {
      await state.write(`history/${name}.json`, st, undefined);
    },
    readHost: async () => (await state.read("status/host.json"))?.raw,
    readPlan: async () => (await state.read("control/calendar-plan.json"))?.raw,
    readBeacon: async () => (await beacon.read("beacon/mode.json"))?.raw,
    describe: () => ec2.describe(),
    start: () => ec2.start(),
    stop: (force) => ec2.stop(force),
    writeBeacon: async (mode, seq, now) => {
      if (beaconKey === undefined) {
        const secret = await secureParameter(ssm, env.BEACON_KEY_PARAM);
        if (secret === undefined) throw new Error("ビーコンの署名鍵（SSM）が無い");
        beaconKey = privateKeyFromSecret(secret);
      }
      await beacon.put("beacon/mode.json", makeBeacon(beaconKey, env.BEACON_KID, mode, seq, now), "application/json", "no-store");
    },
    upsertDns: async (ip) => {
      if (env.DNS_ZONE_ID === undefined || env.DNS_NAME === undefined) return;
      await upsertA(r53, env.DNS_ZONE_ID, env.DNS_NAME, ip);
    },
    notify: async (title, body) => {
      const hook = env.NOTIFY_WEBHOOK_PARAM === undefined ? undefined : await secureParameter(ssm, env.NOTIFY_WEBHOOK_PARAM);
      await notifyDiscord(hook, title, body);
    },
  };
  let result = await runController(ports, request, S.isoSeconds(Date.now()), cfg, env.SITE_URL);
  if (request.action === "status") {
    try {
      if (beaconKey === undefined) {
        const secret = await secureParameter(ssm, env.BEACON_KEY_PARAM);
        if (secret !== undefined) beaconKey = privateKeyFromSecret(secret);
      }
      if (beaconKey !== undefined)
        result = { ...result, beaconPublicKey: { kid: env.BEACON_KID, key: publicKeyRaw(beaconKey).toString("base64url") } };
    } catch {
      // 公開鍵の表示は補助（無くても状態は返す）
    }
  }
  // ログは要約だけ（秘密・業務データは無い）
  console.log(
    JSON.stringify({ action: request.action, ok: result.ok, message: result.message, mode: result.summary["mode"], errors: result.errors }),
  );
  return result;
}
