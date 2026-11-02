/** 外部（GCS・GCP・時計）との境界。試験は偽物を、本番は gcp/ のアダプタを渡す。 */

/**
 * GCS の条件付き書込（ifGenerationMatch）が競合した（HTTP 412）。**自分の書込みが成立していないとは限らない**
 * （応答が失われた書込みの再試行で 412 になることがある）ので、呼出側が再読取りで確認する。
 */
export class ConflictError extends Error {
  override readonly name = "ConflictError";
}

/** 書込みの結果が分からない（通信の切断・タイムアウト・5xx）。成立したかは再読取りで確認する。 */
export class UnknownOutcomeError extends Error {
  override readonly name = "UnknownOutcomeError";
}

/** GCS の generation は int64 なので bigint で扱う（number へ変換しない）。オブジェクトが無いときは 0n。 */
export type Generation = bigint;

export interface StateStore {
  /** (状態の生 JSON, generation)。オブジェクトが無ければ (undefined, 0n)。 */
  read(): Promise<{ raw: unknown; generation: Generation }>;
  /** ifGenerationMatch=ifGeneration で書く。競合なら ConflictError、結果不明なら UnknownOutcomeError。新しい generation を返す。 */
  write(state: unknown, ifGeneration: Generation): Promise<Generation>;
  /** history/ に追記（同じ名前の上書きはしない）。 */
  appendHistory(name: string, state: unknown): Promise<void>;
}

export interface BeaconStore {
  /** beacon/mode.json を書く（Cache-Control: no-store, application/json）。 */
  write(raw: Buffer): Promise<void>;
}

export interface SqlState {
  readonly state: string | undefined;
  readonly activationPolicy: string | undefined;
}

export interface ServiceState {
  readonly ingress: string;
  readonly ready: boolean;
  readonly iapEnabled: boolean;
  readonly iapMembers: number;
  readonly url: string;
}

export interface Gcp {
  sqlState(): Promise<SqlState>;
  sqlSetActivation(policy: "ALWAYS" | "NEVER"): Promise<void>;
  sqlBackup(): Promise<void>;
  serviceState(name: string): Promise<ServiceState>;
  serviceSetIngress(name: string, ingress: "all" | "internal"): Promise<void>;
  /** ID トークンを付けて GET し、HTTP ステータスを返す（到達できなければ 0）。 */
  serviceHealth(name: string, path: string): Promise<number>;
  /** 外部（認証なし）から到達できるか。STOPPED 検証用。 */
  serviceReachableExternally(name: string): Promise<boolean>;
  runningExecutions(): Promise<string[]>;
  cancelExecution(execution: string): Promise<void>;
  /** Job を実行し、終了コードを返す（完了まで待つ）。 */
  runJob(job: string, args: readonly string[]): Promise<number>;
  jobImage(job: string): Promise<string | undefined>;
  jobSetImage(job: string, image: string): Promise<void>;
  serviceImage(name: string): Promise<string | undefined>;
  serviceSetImage(name: string, image: string): Promise<void>;
  schedulerStates(): Promise<Record<string, string>>;
  schedulerPause(name: string): Promise<void>;
  schedulerResume(name: string): Promise<void>;
}

export interface Clock {
  /** UTC ISO 8601（秒、Z） */
  now(): string;
  /** 中断されたら Interrupted で終わる */
  sleep(seconds: number, signal?: AbortSignal): Promise<void>;
}

/** SIGINT/SIGTERM（GitHub Actions のキャンセル）による中断。 */
export class Interrupted extends Error {
  override readonly name = "Interrupted";
}
