/**
 * 本番の GCP アダプタ（gcloud CLI）。旧 gcloud_adapter.py の移植。**実 GCP では未検証**（検証ゲート G-OPS-1〜10。OPERATIONS_DESIGN §12）。
 * コマンドの組み立てと出力の解釈は test/gcloud.test.ts が偽の実行器で検査するが、実際の GCP の応答との一致は保証しない。
 * gcloud の JSON 出力は外部入力として zod で検査し、想定外の形なら例外（fail closed）。
 */
import { spawn } from "node:child_process";
import { z } from "zod";
import { errorMessage, parseJson } from "../json.js";
import { type Gcp, Interrupted, type ServiceState, type SqlState } from "../ports.js";

/** コマンドを実行して (終了コード, 出力) を返す。中断されたら子プロセスを止める。 */
export type Runner = (cmd: readonly string[], signal?: AbortSignal) => Promise<{ code: number; out: string }>;
export type HttpGet = (url: string, token: string | undefined) => Promise<number>;

export const spawnRunner: Runner = (cmd, signal) =>
  new Promise((resolve) => {
    const [exe, ...args] = cmd;
    const opts = signal === undefined ? {} : { signal };
    const p = spawn(exe ?? "false", args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let stdout = "";
    let stderr = "";
    p.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
    });
    p.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
    });
    p.on("error", (e) => resolve({ code: 127, out: errorMessage(e) }));
    p.on("close", (code) => resolve({ code: code ?? 1, out: code === 0 ? stdout : stdout + stderr }));
  });

export const fetchHttpGet: HttpGet = async (url, token) => {
  try {
    const r = await fetch(url, {
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    await r.body?.cancel();
    return r.status;
  } catch {
    return 0;
  }
};

const SqlInstance = z.looseObject({
  state: z.string().optional(),
  settings: z.looseObject({ activationPolicy: z.string().optional() }).optional(),
});
const Annotations = z.record(z.string(), z.string());
const RunService = z.looseObject({
  metadata: z.looseObject({ annotations: Annotations.optional() }).optional(),
  spec: z
    .looseObject({
      template: z
        .looseObject({
          metadata: z.looseObject({ annotations: Annotations.optional() }).optional(),
          spec: z.looseObject({ containers: z.array(z.looseObject({ image: z.string().optional() })).optional() }).optional(),
        })
        .optional(),
    })
    .optional(),
  status: z
    .looseObject({
      url: z.string().optional(),
      conditions: z.array(z.looseObject({ type: z.string().optional(), status: z.string().optional() })).optional(),
    })
    .optional(),
});
const IamPolicy = z
  .looseObject({ bindings: z.array(z.looseObject({ role: z.string().optional(), members: z.array(z.string()).optional() })).optional() })
  .nullable();
const Execution = z.looseObject({
  metadata: z.looseObject({ name: z.string() }),
  status: z
    .looseObject({
      completionTime: z.string().optional(),
      conditions: z.array(z.looseObject({ type: z.string().optional(), status: z.string().optional() })).optional(),
    })
    .optional(),
});
const Executions = z.array(Execution).nullable();
const RunJob = z.looseObject({
  spec: z.looseObject({
    template: z.looseObject({
      spec: z.looseObject({
        template: z.looseObject({ spec: z.looseObject({ containers: z.array(z.looseObject({ image: z.string() })).min(1) }) }),
      }),
    }),
  }),
});
const SchedulerJobs = z.array(z.looseObject({ name: z.string(), state: z.string().optional() })).nullable();

export class GcloudError extends Error {
  override readonly name = "GcloudError";
}

export class GcloudAdapter implements Gcp {
  constructor(
    readonly project: string,
    readonly region: string,
    private readonly run: Runner = spawnRunner,
    private readonly httpGet: HttpGet = fetchHttpGet,
    private readonly idToken?: (audience: string) => Promise<string>,
    private readonly signal?: AbortSignal,
  ) {}

  private async json<T>(cmd: readonly string[], schema: z.ZodType<T>): Promise<T> {
    const { code, out } = await this.run([...cmd, "--format=json", `--project=${this.project}`], this.signal);
    // 出力の全体（秘密を含み得る）は出さない。末尾 200 文字だけ
    if (code !== 0) throw new GcloudError(`gcloud 失敗: ${cmd.slice(0, 4).join(" ")}: ${out.slice(-200)}`);
    const r = schema.safeParse(parseJson(out.trim() === "" ? "null" : out, "gcloud の出力"));
    if (!r.success) throw new GcloudError(`gcloud の出力が想定外: ${cmd.slice(0, 4).join(" ")}: ${r.error.issues[0]?.message ?? "?"}`);
    return r.data;
  }

  private async ok(cmd: readonly string[]): Promise<void> {
    const { code, out } = await this.run([...cmd, `--project=${this.project}`, "--quiet"], this.signal);
    if (code !== 0) throw new GcloudError(`gcloud 失敗: ${cmd.slice(0, 4).join(" ")}: ${out.slice(-200)}`);
  }

  // ---- Cloud SQL
  async sqlState(): Promise<SqlState> {
    const d = await this.json(["gcloud", "sql", "instances", "describe", "jra-bot-db"], SqlInstance);
    return { state: d.state, activationPolicy: d.settings?.activationPolicy };
  }

  async sqlSetActivation(policy: "ALWAYS" | "NEVER"): Promise<void> {
    if (policy !== "ALWAYS" && policy !== "NEVER") throw new GcloudError(`activation policy が不正: ${String(policy)}`);
    await this.ok(["gcloud", "sql", "instances", "patch", "jra-bot-db", `--activation-policy=${policy}`]);
  }

  async sqlBackup(): Promise<void> {
    await this.ok(["gcloud", "sql", "backups", "create", "--instance=jra-bot-db"]);
  }

  // ---- Cloud Run service
  async serviceState(name: string): Promise<ServiceState> {
    const d = await this.json(["gcloud", "run", "services", "describe", name, `--region=${this.region}`], RunService);
    const ann = d.metadata?.annotations ?? {};
    const tann = d.spec?.template?.metadata?.annotations ?? {};
    const ready = (d.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True");
    const iap = ann["run.googleapis.com/iap-enabled"] === "true" || tann["run.googleapis.com/iap-enabled"] === "true";
    let members = 0;
    if (name.endsWith("dashboard")) {
      try {
        const pol = await this.json(
          ["gcloud", "iap", "web", "get-iam-policy", "--resource-type=cloud-run", `--service=${name}`, `--region=${this.region}`],
          IamPolicy,
        );
        members = (pol?.bindings ?? [])
          .filter((b) => b.role === "roles/iap.httpsResourceAccessor")
          .reduce((n, b) => n + (b.members ?? []).length, 0);
      } catch (e) {
        if (!(e instanceof GcloudError)) throw e;
        members = 0; // 読めない = 0 件扱い（開ける判断を安全側に）
      }
    }
    return { ingress: ann["run.googleapis.com/ingress"] ?? "all", ready, iapEnabled: iap, iapMembers: members, url: d.status?.url ?? "" };
  }

  async serviceSetIngress(name: string, ingress: "all" | "internal"): Promise<void> {
    if (ingress !== "all" && ingress !== "internal") throw new GcloudError(`ingress が不正: ${String(ingress)}`);
    await this.ok(["gcloud", "run", "services", "update", name, `--region=${this.region}`, `--ingress=${ingress}`]);
  }

  private async defaultIdToken(audience: string): Promise<string> {
    const { code, out } = await this.run(["gcloud", "auth", "print-identity-token", `--audience=${audience}`], this.signal);
    if (code !== 0) throw new GcloudError("ID トークンを取得できない");
    return out.trim();
  }

  async serviceHealth(name: string, path: string): Promise<number> {
    const url = (await this.serviceState(name)).url;
    if (url === "") return 0;
    const token = this.idToken !== undefined ? await this.idToken(url) : await this.defaultIdToken(url);
    return this.httpGet(url + path, token);
  }

  async serviceReachableExternally(name: string): Promise<boolean> {
    const url = (await this.serviceState(name)).url;
    const code = url !== "" ? await this.httpGet(`${url}/`, undefined) : 0;
    return code !== 0 && code !== 403 && code !== 404; // ingress=internal は Google のフロントが 404/403 を返す
  }

  async serviceImage(name: string): Promise<string | undefined> {
    try {
      const d = await this.json(["gcloud", "run", "services", "describe", name, `--region=${this.region}`], RunService);
      return d.spec?.template?.spec?.containers?.[0]?.image;
    } catch (e) {
      if (e instanceof GcloudError) return undefined;
      throw e;
    }
  }

  // ---- Cloud Run Jobs
  async runningExecutions(): Promise<string[]> {
    const d = (await this.json(["gcloud", "run", "jobs", "executions", "list", `--region=${this.region}`], Executions)) ?? [];
    // 『完了時刻が無い』ものを実行中として数える（runningCount だけだと、開始待ち・イメージ取得中を見落とす）
    return d
      .filter((e) => {
        const st = e.status ?? {};
        const completed = (st.conditions ?? []).some((c) => c.type === "Completed" && (c.status === "True" || c.status === "False"));
        return st.completionTime === undefined && !completed;
      })
      .map((e) => e.metadata.name);
  }

  async cancelExecution(execution: string): Promise<void> {
    await this.ok(["gcloud", "run", "jobs", "executions", "cancel", execution, `--region=${this.region}`]);
  }

  private async executionNames(job: string): Promise<Set<string>> {
    try {
      const d =
        (await this.json(
          ["gcloud", "run", "jobs", "executions", "list", `--job=${job}`, `--region=${this.region}`],
          z.array(z.unknown()).nullable(),
        )) ?? [];
      return new Set(d.map((e) => Execution.safeParse(e)).flatMap((r) => (r.success ? [r.data.metadata.name] : [])));
    } catch (e) {
      if (e instanceof GcloudError) return new Set();
      throw e;
    }
  }

  async runJob(job: string, args: readonly string[]): Promise<number> {
    const known = await this.executionNames(job); // 今回の execution だけを後で特定するため、実行前の一覧を控える
    const cmd = [
      "gcloud",
      "run",
      "jobs",
      "execute",
      job,
      `--region=${this.region}`,
      "--wait",
      `--args=${args.join(",")}`,
      `--project=${this.project}`,
      "--quiet",
    ];
    const { code, out } = await this.run(cmd, this.signal);
    // 中断で gcloud を止めた（Cloud 上の execution は続く）。終了コードを推測しない
    if (this.signal?.aborted === true) throw new Interrupted("中断（Job の実行は Cloud Run 上で続いている可能性がある）");
    if (code === 0) return 0;
    const m = /exit\((\d+)\)/.exec(out);
    if (m?.[1] !== undefined) return Number(m[1]);
    // 出力に終了コードが無い場合は、**今回新しくできた** execution の記述から探す（形式は実 GCP で未確認: G-OPS-10）。見つからなければ 1（fail closed）
    try {
      const d =
        (await this.json(
          ["gcloud", "run", "jobs", "executions", "list", `--job=${job}`, `--region=${this.region}`],
          z.array(z.unknown()).nullable(),
        )) ?? [];
      const fresh = d.filter((e) => {
        const r = Execution.safeParse(e);
        return r.success && !known.has(r.data.metadata.name);
      });
      const m2 = /exit\((\d+)\)/.exec(JSON.stringify(fresh));
      if (m2?.[1] !== undefined) return Number(m2[1]);
    } catch (e) {
      if (!(e instanceof GcloudError)) throw e;
    }
    return 1;
  }

  /** Job の現在のイメージ（deploy が失敗時に戻すため）。取れなければ undefined。 */
  async jobImage(job: string): Promise<string | undefined> {
    try {
      const d = await this.json(["gcloud", "run", "jobs", "describe", job, `--region=${this.region}`], RunJob);
      return d.spec.template.spec.template.spec.containers[0]?.image;
    } catch (e) {
      if (e instanceof GcloudError) return undefined;
      throw e;
    }
  }

  /** deploy 用。イメージだけを更新する（環境変数・Secret・args・実行はしない）。 */
  async jobSetImage(job: string, image: string): Promise<void> {
    await this.ok(["gcloud", "run", "jobs", "update", job, `--region=${this.region}`, `--image=${image}`]);
  }

  /** deploy 用。イメージだけを更新する（ingress・IAP・IAM には触れない）。 */
  async serviceSetImage(name: string, image: string): Promise<void> {
    await this.ok(["gcloud", "run", "services", "update", name, `--region=${this.region}`, `--image=${image}`]);
  }

  // ---- Scheduler
  async schedulerStates(): Promise<Record<string, string>> {
    const d = (await this.json(["gcloud", "scheduler", "jobs", "list", `--location=${this.region}`], SchedulerJobs)) ?? [];
    const out: Record<string, string> = {};
    for (const j of d) out[j.name.split("/").at(-1) ?? j.name] = j.state ?? "?";
    return out;
  }

  async schedulerPause(name: string): Promise<void> {
    await this.ok(["gcloud", "scheduler", "jobs", "pause", name, `--location=${this.region}`]);
  }

  async schedulerResume(name: string): Promise<void> {
    await this.ok(["gcloud", "scheduler", "jobs", "resume", name, `--location=${this.region}`]);
  }
}
