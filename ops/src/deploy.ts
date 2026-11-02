/**
 * deploy（イメージ更新）。入力は release-manifest だけ（web CONTRACTS §10 / infra I-H3・I-H9）。旧 ops/jrabot_ops/deploy.py の移植。
 *
 * 順序（前進）: ① manifest 検証（スキーマ・プロジェクト・digest 固定・min_app_release ≤ release）→ ② 運用モードとリース（start/stop と排他）
 * → ③ db-migration Job のイメージ更新 → validate（0/10/1/75）→ 10 なら migrate → 再 validate が 0 → ④ 各 Job → ⑤ ingest → dashboard
 * → ⑥ ヘルスチェック → ⑦ ingress・IAP が前後で変わっていない → ⑧ ops-state.release に記録。**マイグレーションがアプリより先**。
 *
 * ロールバック（CONTRACTS §10 のロールバック規則。既知の問題 4 の修正）: 対象の release が、記録されている現在の app_release より古いとき。
 *  - 対象 release ≥ **DB に適用済みのスキーマの min_app_release**（schema_min_app_release）でなければ拒否する。
 *  - 対象の required_schema_version ≤ 適用済みのスキーマ版でなければ拒否する。
 *  - **DB スキーマは戻さない**: db-migration のイメージは更新せず、migrate も実行しない（現在の db-migration で validate だけ行う）。
 * deploy は ingress・IAP・Scheduler・運用モード・DB の起動状態を変更しない（それらは ops の start/stop だけ）。
 */
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import { DB_JOB, type Ops, SERVICES, StepFailed } from "./engine.js";
import { errorMessage, isRecord, parseJson } from "./json.js";
import { Interrupted } from "./ports.js";
import * as S from "./state.js";

export const BOT_JOBS = ["jra-bot-bot-run", "jra-bot-calendar-check", "jra-bot-reconcile", "jra-bot-retention"] as const;
export const ML_JOB = "jra-bot-ml-train";
export const CONTRACT_MAJOR_MINOR = "0.4";
export const REGION = "asia-northeast1";

export class DeployRejected extends Error {
  override readonly name = "DeployRejected";
}

/** deploy が使う manifest の部分（スキーマ検証の後に、型として取り出す）。 */
const ManifestSchema = z.looseObject({
  release: z.string(),
  git_sha: z.string(),
  contract_version: z.string(),
  required_schema_version: z.string(),
  flyway: z.looseObject({ latest_version: z.string() }),
  rollback: z.looseObject({ min_app_release: z.string() }),
  images: z.looseObject({
    dashboard: z.string(),
    ingest: z.string(),
    bot: z.string(),
    "db-migration": z.string(),
    "ml-train": z.string(),
  }),
});
export type Manifest = z.infer<typeof ManifestSchema>;

/** 版（2026.11.0 や 5）を数値の組として比較する。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "0";
    const y = pb[i] ?? "0";
    if (!/^\d+$/.test(x) || !/^\d+$/.test(y)) throw new DeployRejected(`版の形式が不正: ${a} / ${b}`);
    const d = Number(x) - Number(y);
    if (d !== 0) return d;
  }
  return 0;
}

export function checkManifest(raw: unknown, schema: unknown, project: string): { problems: string[]; manifest?: Manifest } {
  if (!isRecord(schema)) return { problems: ["スキーマがオブジェクトではない"] };
  const validate = new Ajv2020({ strict: true, allErrors: true, validateFormats: false }).compile(schema);
  if (!validate(raw)) {
    return { problems: (validate.errors ?? []).map((e) => `$${e.instancePath.replaceAll("/", ".")}: ${e.message ?? e.keyword}`) };
  }
  const problems: string[] = [];
  if (isRecord(raw) && ("kind" in raw || raw["deployable"] === false)) problems.push("プレビュー manifest は deploy に使えない");
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success)
    return { problems: [...problems, `manifest の形式が deploy の想定と違う: ${parsed.error.issues[0]?.message ?? "?"}`] };
  const m = parsed.data;
  const prefix = `${REGION}-docker.pkg.dev/${project}/jra-bot/`;
  for (const [name, ref] of Object.entries(m.images)) {
    if (typeof ref !== "string") continue;
    if (!ref.startsWith(prefix)) problems.push(`images.${name} がこのプロジェクト(${project})の Artifact Registry ではない`);
    if (!/@sha256:[0-9a-f]{64}$/.test(ref)) problems.push(`images.${name} が digest 固定ではない`);
  }
  if (!m.contract_version.startsWith(`${CONTRACT_MAJOR_MINOR}.`)) {
    problems.push(`contract_version ${m.contract_version} は deploy が対応する ${CONTRACT_MAJOR_MINOR}.x ではない`);
  }
  try {
    if (compareVersions(m.rollback.min_app_release, m.release) > 0)
      problems.push("rollback.min_app_release が release より新しい（契約違反）");
    if (compareVersions(m.required_schema_version, m.flyway.latest_version) > 0)
      problems.push("required_schema_version が flyway.latest_version より新しい");
  } catch (e) {
    problems.push(errorMessage(e));
  }
  return problems.length > 0 ? { problems } : { problems, manifest: m };
}

export type DeployKind = "forward" | "redeploy" | "rollback";

/** ロールバック判定（純粋関数）。current は ops-state.release（初回は null）。 */
export function judge(m: Manifest, current: S.ReleaseInfo | null | undefined): { kind: DeployKind; problems: string[] } {
  if (current === null || current === undefined) return { kind: "forward", problems: [] };
  // 記録の形式を先に検査する（不正なら、イメージを替える前に拒否する）
  try {
    compareVersions(current.schema_min_app_release, m.release);
    compareVersions(current.schema_flyway_version, m.flyway.latest_version);
  } catch (e) {
    return { kind: "forward", problems: [`ops-state.release の記録が不正: ${errorMessage(e)}`] };
  }
  const cmp = compareVersions(m.release, current.app_release);
  if (cmp > 0) {
    if (compareVersions(m.flyway.latest_version, current.schema_flyway_version) < 0) {
      return {
        kind: "forward",
        problems: [
          `新しい release なのに flyway.latest_version (${m.flyway.latest_version}) が適用済み (${current.schema_flyway_version}) より古い`,
        ],
      };
    }
    return { kind: "forward", problems: [] };
  }
  if (cmp === 0) {
    if (m.git_sha !== current.git_sha)
      return { kind: "redeploy", problems: [`同じ release ${m.release} で git_sha が違う（release を上げること）`] };
    return { kind: "redeploy", problems: [] };
  }
  const problems: string[] = [];
  if (compareVersions(m.release, current.schema_min_app_release) < 0) {
    problems.push(
      `ロールバック先 ${m.release} は、適用済みのスキーマ（V${current.schema_flyway_version}）で動作確認された最も古いリリース ${current.schema_min_app_release} より古い（CONTRACTS §10。DB は戻さない）`,
    );
  }
  if (compareVersions(m.required_schema_version, current.schema_flyway_version) > 0) {
    problems.push(
      `ロールバック先が要求するスキーマ版 ${m.required_schema_version} が適用済みの ${current.schema_flyway_version} より新しい`,
    );
  }
  return { kind: "rollback", problems };
}

export interface DeployInputs {
  readonly project: string;
  readonly allowWhenStopped: boolean;
  readonly applyMigrations: boolean;
  readonly actor: string;
  readonly runId: string;
  readonly runUrl: string;
  readonly reason: string;
}

export interface DeployResult {
  readonly release: string;
  readonly git_sha: string;
  readonly mode: S.Mode;
  readonly kind: DeployKind;
  readonly done: readonly string[];
}

/** ops（状態・リース・GCP）を使って deploy する。拒否・失敗は DeployRejected（終了コード 3）。 */
export async function deploy(
  ops: Ops,
  rawManifest: unknown,
  schema: unknown,
  i: DeployInputs,
  log: (s: string) => void = () => {},
): Promise<DeployResult> {
  const { problems, manifest: m } = checkManifest(rawManifest, schema, i.project);
  if (problems.length > 0 || m === undefined) throw new DeployRejected(`manifest 不正: ${problems.join(" / ")}`);
  // 拒否の判定は**何も書かずに**先に行う（終了コード 3 は『状態を変えていない』。ops-state が無ければ UNKNOWN として拒否し、初期化もしない）
  const { raw } = await ops.store.read();
  if (raw === undefined) throw new DeployRejected("ops-state が無い（mode=UNKNOWN）。初期導入の手順で ops-start/stop を先に実行する");
  let pre: S.OpsState;
  try {
    pre = S.validate(raw);
  } catch (e) {
    throw new DeployRejected(`ops-state が不正（mode=UNKNOWN）: ${errorMessage(e)}`);
  }
  if (!S.ALLOWED_FROM.deploy.has(pre.mode)) throw new DeployRejected(`mode=${pre.mode} の間は deploy しない（start/stop の完了後に実行）`);
  if (pre.mode === "STOPPED" && !i.allowWhenStopped) {
    throw new DeployRejected(
      "mode=STOPPED の deploy は既定で拒否（allow_when_stopped=true でイメージ参照の更新だけ。migration は実行しない）",
    );
  }
  const pj = judge(m, pre.release);
  if (pj.problems.length > 0) throw new DeployRejected(`ロールバック判定: ${pj.problems.join(" / ")}`);
  const leaseProblem = S.leaseProblem(pre, i.runId, "deploy", ops.clock.now(), false);
  if (leaseProblem !== undefined) throw new DeployRejected(leaseProblem);
  try {
    await ops.begin("deploy", { actor: i.actor, reason: i.reason, runId: i.runId, runUrl: i.runUrl });
  } catch (e) {
    if (e instanceof S.Rejected) throw new DeployRejected(`mode=${ops.state.mode}: ${e.message}（start/stop の完了後に実行）`);
    throw e;
  }
  const mode = ops.state.mode;
  const done: string[] = [];
  // 先に上げたロールバックの下限を、migrate を一度も実行しないまま失敗したときだけ元に戻すための記録
  const releaseBefore = structuredClone(ops.state.release ?? null);
  let migrateAttempted = false;
  try {
    // begin が読んだ最新の状態で判定し直す（読んでからリースを取るまでの間に他の操作が入った場合）
    if (mode === "STOPPED" && !i.allowWhenStopped) throw new DeployRejected("mode=STOPPED の deploy は既定で拒否");
    const j = judge(m, ops.state.release);
    if (j.problems.length > 0) throw new DeployRejected(`ロールバック判定: ${j.problems.join(" / ")}`);
    const gcp = ops.gcp;
    const snapshot = async (): Promise<string> => {
      const parts: string[] = [];
      for (const n of SERVICES) {
        const st = await gcp.serviceState(n);
        parts.push(`${n}:${st.ingress}:${st.iapEnabled}`);
      }
      return parts.join(",");
    };
    const before = await snapshot();
    const img = m.images;
    const maxV = (a: string, b: string): string => (compareVersions(a, b) >= 0 ? a : b);
    if (j.kind === "forward") {
      // db-migration のイメージを替える**前に**ロールバックの下限を安全側に上げて記録する（migrate 中に中断されても、
      // Cloud Run 上の migrate は続いて DB が進み得る。記録が古いままだと、進んだスキーマで動かない版へ戻せてしまう）。
      // 適用済みの版は下げない・上げない（実際に migrate した確認の後で上げる）。初回は app_release を対象の版、適用済みの版を 0 として記録する（保守的）
      const prevRel = ops.state.release;
      const s0 = structuredClone(ops.state);
      s0.release =
        prevRel === null || prevRel === undefined
          ? {
              app_release: m.release,
              git_sha: m.git_sha,
              schema_min_app_release: m.rollback.min_app_release,
              schema_flyway_version: "0",
              deployed_at: ops.clock.now(),
              run_id: i.runId,
            }
          : { ...prevRel, schema_min_app_release: maxV(prevRel.schema_min_app_release, m.rollback.min_app_release) };
      await ops.commit(s0, "rollback-bound-raised");
    }
    if (mode === "NORMAL") {
      await ops.step("D1_migration", async () => {
        if (j.kind === "rollback") {
          // DB スキーマは戻さない。現在の db-migration（新しい側）で、DB が健全なことだけ確かめる
          const code = await gcp.runJob(DB_JOB, ["--mode=validate"]);
          if (code !== 0)
            throw new DeployRejected(`ロールバック前の validate が終了コード ${code}（DB の状態が不正。アプリは更新していない）`);
          return "rollback: schema unchanged";
        }
        const previous = await gcp.jobImage(DB_JOB);
        await gcp.jobSetImage(DB_JOB, img["db-migration"]);
        const fail = async (msg: string): Promise<DeployRejected> => {
          // 検証できなかった db-migration のイメージを残さない（残ると、以後の ops-start が未検証の版で動く）
          if (previous !== undefined && previous !== img["db-migration"]) {
            try {
              await gcp.jobSetImage(DB_JOB, previous);
              return new DeployRejected(`${msg}（db-migration のイメージは前の版に戻した）`);
            } catch (e) {
              return new DeployRejected(`${msg}（db-migration のイメージを戻せなかった: ${errorMessage(e)}。手動で前の版に戻すこと）`);
            }
          }
          return new DeployRejected(msg);
        };
        let code = await gcp.runJob(DB_JOB, ["--mode=validate"]);
        if (code === 10) {
          if (!i.applyMigrations) throw await fail("未適用のマイグレーションがある（apply_migrations=true で実行）");
          log("未適用のマイグレーションを適用する");
          migrateAttempted = true;
          if ((await gcp.runJob(DB_JOB, ["--mode=migrate"])) !== 0) throw await fail("migrate が失敗（アプリは更新していない）");
          code = await gcp.runJob(DB_JOB, ["--mode=validate"]);
        }
        if (code !== 0)
          throw await fail(`db-migration validate が終了コード ${code}（0 以外。アプリは更新していない。1=不一致/失敗版、75=DB 不達）`);
        return "migrated/validated";
      });
      done.push("migration");
    } else if (j.kind !== "rollback") {
      await gcp.jobSetImage(DB_JOB, img["db-migration"]); // STOPPED: 参照の更新だけ（migration は次の ops-start / deploy）
    }
    await ops.step("D2_jobs", async () => {
      for (const job of BOT_JOBS) await gcp.jobSetImage(job, img.bot);
      await gcp.jobSetImage(ML_JOB, img["ml-train"]);
      return "jobs updated";
    });
    done.push("jobs");
    for (const [name, key] of [
      ["jra-bot-ingest", "ingest"],
      ["jra-bot-dashboard", "dashboard"],
    ] as const) {
      await ops.step(`D3_${key}`, async () => {
        await gcp.serviceSetImage(name, img[key]);
        return "image updated";
      });
      done.push(name);
    }
    if (mode === "NORMAL") {
      for (const name of SERVICES) {
        const code = await gcp.serviceHealth(name, "/internal/ready");
        if (code !== 200) throw new DeployRejected(`${name} のヘルスチェックが ${code}（ロールバックは手順書。mode は変更していない）`);
      }
    }
    const after = await snapshot();
    if (after !== before) throw new DeployRejected(`deploy の前後で ingress/IAP が変わった: ${before} → ${after}`);
    // 記録: DB に適用済みのスキーマの情報は、ロールバックでは下げない（前進修正のみ）。STOPPED では migration していないので変えない
    const migrated = mode === "NORMAL" && j.kind !== "rollback";
    // 下限（schema_min_app_release）は前進 deploy の前に安全側に上げてある（上で記録）。ここでは常に max を取り、下げない。
    // 適用済みの版（schema_flyway_version）は実際に migrate・validate できたときだけ上げる（低めに持つ = ロールバックの検査が厳しくなる方向）
    const cur = ops.state.release;
    const s = structuredClone(ops.state);
    s.release = {
      app_release: m.release,
      git_sha: m.git_sha,
      schema_min_app_release:
        cur === null || cur === undefined
          ? m.rollback.min_app_release
          : j.kind === "forward"
            ? maxV(cur.schema_min_app_release, m.rollback.min_app_release)
            : cur.schema_min_app_release,
      schema_flyway_version: migrated
        ? cur === null || cur === undefined
          ? m.flyway.latest_version
          : maxV(cur.schema_flyway_version, m.flyway.latest_version)
        : (cur?.schema_flyway_version ?? "0"),
      deployed_at: ops.clock.now(),
      run_id: i.runId,
    };
    await ops.commit(s, "release-recorded");
    await ops.end(true, null, false); // deploy の SA は Cloud SQL・Scheduler を読めないので、start/stop が記録した last_actual を上書きしない
    return { release: m.release, git_sha: m.git_sha, mode, kind: j.kind, done };
  } catch (e) {
    try {
      if (!migrateAttempted && !(e instanceof Interrupted)) {
        // DB は進んでいない（validate で止まった・アプリの更新で失敗した）。イメージを前の版に戻したので、記録も元に戻す
        const r = structuredClone(ops.state);
        r.release = releaseBefore;
        if (JSON.stringify(r.release) !== JSON.stringify(ops.state.release)) await ops.commit(r, "rollback-bound-restored");
      }
      await ops.end(false, e instanceof Error ? e.message : String(e), false);
    } catch {
      // 記録できなくても元の失敗を伝える
    }
    if (e instanceof DeployRejected) throw e;
    if (e instanceof StepFailed || e instanceof S.Rejected) throw new DeployRejected(e.message);
    throw e;
  }
}

export function loadJson(path: string): unknown {
  return parseJson(readFileSync(path, "utf8"), path);
}
