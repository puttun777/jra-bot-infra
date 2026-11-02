/**
 * ops-state.json の構造と遷移規則（OPERATIONS_DESIGN §1・§2）。純粋な関数だけ（GCP に触れない）。旧 ops/jrabot_ops/state.py の移植。
 * 外部入力（GCS から読んだ JSON）は zod で検査する。未知のフィールドは保持して書き戻す（将来の追加を落とさない）。
 */
import { z } from "zod";

export const SCHEMA_VERSION = 1;
export const MODES = ["NORMAL", "STARTING", "STOPPING", "STOPPED"] as const;
export type Mode = (typeof MODES)[number];
export const LEASE_MINUTES = 90;
export type OpType = "start" | "stop" | "deploy";

/** 操作 → 許可される現在のモード（修復モードを含む）。deploy は安定状態だけ（STOPPED は deploy 側で明示の許可が要る）。 */
export const ALLOWED_FROM: Readonly<Record<OpType, ReadonlySet<Mode>>> = {
  start: new Set<Mode>(["STOPPED", "STARTING", "NORMAL"]),
  stop: new Set<Mode>(["NORMAL", "STARTING", "STOPPING", "STOPPED"]),
  deploy: new Set<Mode>(["NORMAL", "STOPPED"]),
};

/** 遷移規則・リース・不正な状態による拒否。状態は変えていない（終了コード 3）。 */
export class Rejected extends Error {
  override readonly name = "Rejected";
}

const ts = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "UTC の ISO 8601（秒、Z）");

const StepSchema = z.looseObject({ name: z.string(), status: z.enum(["RUNNING", "DONE", "FAILED"]), at: ts, detail: z.string() });
export type Step = z.infer<typeof StepSchema>;

const OperationSchema = z.looseObject({
  id: z.string().optional(),
  type: z.string(),
  status: z.string(),
  force: z.boolean().optional(),
  run_url: z.string().optional(),
  actor: z.string().optional(),
  started_at: ts.nullable().optional(),
  finished_at: ts.nullable().optional(),
  current_step: z.string().nullable().optional(),
  steps: z.array(StepSchema).default([]),
  error: z.string().nullable().optional(),
});
export type Operation = z.infer<typeof OperationSchema>;

const LeaseSchema = z.looseObject({ holder: z.string().min(1), expires_at: ts });
export type Lease = z.infer<typeof LeaseSchema>;

const BeaconInfoSchema = z.looseObject({
  seq: z.number().int(),
  mode: z.string(),
  updated_at: z.string(),
  kid: z.string().optional(),
});

/** deploy が記録する、いま動いているリリース（ロールバック判定の基準。CONTRACTS §10）。 */
const ReleaseSchema = z.looseObject({
  app_release: z.string(),
  git_sha: z.string(),
  /** DB に適用済みのスキーマを持ち込んだリリースの min_app_release（DB は前進のみなので、ロールバックしても下がらない） */
  schema_min_app_release: z.string(),
  schema_flyway_version: z.string(),
  deployed_at: ts,
  run_id: z.string(),
});
export type ReleaseInfo = z.infer<typeof ReleaseSchema>;

export const OpsStateSchema = z.looseObject({
  schema_version: z.literal(SCHEMA_VERSION),
  /** 2^53 を超える seq は表現の一致を保証できないので拒否（JavaScript の number へ黙って丸めない） */
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  mode: z.enum(MODES),
  desired: z.looseObject({ mode: z.string(), set_by: z.string().optional(), set_at: z.string().optional(), reason: z.string().optional() }),
  operation: OperationSchema.nullable().optional(),
  lease: LeaseSchema.nullable().optional(),
  beacon: BeaconInfoSchema.nullable().optional(),
  last_actual: z.record(z.string(), z.unknown()).nullable().optional(),
  release: ReleaseSchema.nullable().optional(),
});
export type OpsState = z.infer<typeof OpsStateSchema>;

function clone<T>(v: T): T {
  return structuredClone(v);
}

function parseTs(s: string): number {
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Rejected(`日時が不正: ${s}`);
  return t;
}

export function isoSeconds(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/** 最初の状態（STOPPED。DB 停止・受付停止の初期値と一致させる）。 */
export function initialState(now: string): OpsState {
  return {
    schema_version: SCHEMA_VERSION,
    seq: 1,
    mode: "STOPPED",
    desired: { mode: "STOPPED", set_by: "init", set_at: now, reason: "初期状態" },
    operation: null,
    lease: null,
    beacon: null,
    last_actual: null,
    release: null,
  };
}

/** 外部から読んだ値を検査する。不正なら Rejected（状態を変えない）。 */
export function validate(raw: unknown): OpsState {
  const r = OpsStateSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new Rejected(`ops-state が不正: ${issue === undefined ? "?" : `${issue.path.join(".")}: ${issue.message}`}`);
  }
  return r.data;
}

export type TransitionKind = "normal" | "resume" | "repair";

/** 操作を始めてよいか。拒否は Rejected。 */
export function checkTransition(state: OpsState, op: OpType, force: boolean): TransitionKind {
  const mode = state.mode;
  if (!ALLOWED_FROM[op].has(mode)) {
    if (force && op !== "deploy") return "repair";
    throw new Rejected(
      `${op} は mode=${mode} から実行できない（STOPPING → start は、停止を完了させてから。強制するなら force=true と理由）`,
    );
  }
  if (op === "deploy") return "normal";
  if (op === "start") return ({ STOPPED: "normal", STARTING: "resume", NORMAL: "repair", STOPPING: "repair" } as const)[mode];
  return ({ NORMAL: "normal", STARTING: "normal", STOPPING: "resume", STOPPED: "repair" } as const)[mode];
}

/** リースを取れるかの判定だけ（書かない）。dry-run とリース取得の両方が使う。 */
export function leaseProblem(state: OpsState, holder: string, op: OpType, now: string, force: boolean): string | undefined {
  const lease = state.lease;
  if (lease === null || lease === undefined || lease.holder === holder) return undefined;
  const expired = parseTs(lease.expires_at) <= parseTs(now);
  const sameKind = state.operation?.type === op;
  if (!expired && !force) return `別の操作（${lease.holder}）がリースを保持している（期限 ${lease.expires_at}）`;
  if (expired && !sameKind && !force) return "期限切れのリースは同じ種類の操作の再実行だけが奪取できる（force=true と理由で奪取）";
  return undefined;
}

/** リースを取る。期限内の別の保持者がいれば拒否。期限切れは同じ種類の操作の再実行だけが奪取できる（force なら奪取）。 */
export function acquireLease(state: OpsState, holder: string, op: OpType, now: string, force: boolean): OpsState {
  const problem = leaseProblem(state, holder, op, now, force);
  if (problem !== undefined) throw new Rejected(problem);
  const s = clone(state);
  s.lease = { holder, expires_at: isoSeconds(parseTs(now) + LEASE_MINUTES * 60_000) };
  return s;
}

export function releaseLease(state: OpsState, holder: string): OpsState {
  const s = clone(state);
  if (s.lease?.holder === holder) s.lease = null;
  return s;
}

export function withOperation(
  state: OpsState,
  op: OpType,
  opId: string,
  actor: string,
  runUrl: string,
  force: boolean,
  now: string,
  resume: boolean,
): OpsState {
  const s = clone(state);
  const prev = s.operation;
  // 同じ種類の操作の再実行は完了済みのステップを引き継ぐ（冪等な続き）
  const keep = resume && prev?.type === op && prev.status === "FAILED" ? prev.steps.map((x) => ({ ...x })) : [];
  s.operation = {
    id: opId,
    type: op,
    status: "RUNNING",
    force,
    run_url: runUrl,
    actor,
    started_at: now,
    finished_at: null,
    current_step: null,
    steps: keep,
    error: null,
  };
  return s;
}

export function stepDone(state: OpsState, name: string): boolean {
  return (state.operation?.steps ?? []).some((x) => x.name === name && x.status === "DONE");
}

export function recordStep(state: OpsState, name: string, status: Step["status"], now: string, detail = ""): OpsState {
  const s = clone(state);
  const op = s.operation;
  if (op === null || op === undefined) throw new Error("operation が無いのにステップを記録しようとした");
  op.current_step = name;
  op.steps = [...op.steps.filter((x) => x.name !== name), { name, status, at: now, detail: detail.slice(0, 300) }];
  return s;
}

export function setMode(state: OpsState, mode: Mode, desired: Mode, actor: string, reason: string, now: string): OpsState {
  const s = clone(state);
  s.mode = mode;
  s.desired = { mode: desired, set_by: actor, set_at: now, reason };
  return s;
}

export function bump(state: OpsState): OpsState {
  const s = clone(state);
  if (state.seq >= Number.MAX_SAFE_INTEGER) throw new Rejected("seq が上限に達した");
  s.seq = state.seq + 1;
  return s;
}

export function finish(state: OpsState, ok: boolean, now: string, error: string | null): OpsState {
  const s = clone(state);
  const op = s.operation;
  if (op === null || op === undefined) return s;
  op.status = ok ? "SUCCEEDED" : "FAILED";
  op.finished_at = now;
  op.error = ok ? null : (error ?? "").slice(0, 500);
  return s;
}
