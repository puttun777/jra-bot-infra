/**
 * ワークフローから呼ぶ入口。`node build/ops/src/cli.js <start|stop|status|mode|deploy|plan-guard> ...`（旧 `python -m jrabot_ops.cli` の移植。引数名は同じ）。
 *
 * 認証は実行環境（GitHub Actions の WIF → sa-gha-ops）が与える。長期キーは受け取らない。ビーコンの署名鍵は Secret Manager から実行時に読み、ログに出さない。
 * 終了コード（契約。旧版と同じ）: 0 成功 / 1 失敗（STARTING・STOPPING のまま残り得る。再実行で続きから。**中断（キャンセル）も 1**）
 *                               / 2 引数・入力の誤り / 3 拒否（排他・遷移禁止・ガード・deploy の拒否）。
 * GitHub Actions のキャンセルは SIGINT → SIGTERM（→ SIGKILL）。最初のシグナルで中断を要求し、リースの解放と FAILED の記録を行う
 * （2 回目以降のシグナルは無視して解放処理を続ける。既知の問題 5 の修正）。
 */
import { parseArgs } from "node:util";
import { privateKeyFromSecret } from "./beacon.js";
import { DeployRejected, deploy, loadJson } from "./deploy.js";
import { Ops, StepFailed } from "./engine.js";
import { GcloudAdapter, spawnRunner } from "./gcp/gcloud.js";
import { GcsBeaconStore, GcsClient, GcsStateStore, gcloudToken } from "./gcp/gcs.js";
import { errorMessage } from "./json.js";
import * as planGuard from "./plan-guard.js";
import { type Clock, Interrupted } from "./ports.js";
import * as S from "./state.js";
import { collect, hasProblem, render } from "./status.js";

export class UsageError extends Error {
  override readonly name = "UsageError";
}

export const systemClock: Clock = {
  now: () => S.isoSeconds(Date.now()),
  sleep: (seconds, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new Interrupted("中断"));
        return;
      }
      const t = setTimeout(resolve, seconds * 1000);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new Interrupted("中断"));
        },
        { once: true },
      );
    }),
};

const COMMON = {
  project: { type: "string" },
  region: { type: "string", default: "asia-northeast1" },
  kid: { type: "string", default: "beacon-1" },
  actor: { type: "string" },
  "run-id": { type: "string" },
  "run-url": { type: "string", default: "" },
  reason: { type: "string", default: "" },
  force: { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
} as const;

function need(v: string | undefined, flag: string): string {
  if (v === undefined || v === "") throw new UsageError(`${flag} が必要`);
  return v;
}

async function secret(project: string, name: string, signal: AbortSignal): Promise<string> {
  const { code, out } = await spawnRunner(
    ["gcloud", "secrets", "versions", "access", "latest", `--secret=${name}`, `--project=${project}`],
    signal,
  );
  if (code !== 0) throw new Error(`Secret ${name} を読めない`); // 出力（秘密の断片）は出さない
  return out;
}

/** ops-state とビーコンの保管。GCS には中断の signal を渡さない（中断の後も解放・記録を書けるように。タイムアウトはリクエストごと） */
function stores(project: string) {
  const gcs = new GcsClient(fetch, gcloudToken(spawnRunner));
  return { state: new GcsStateStore(gcs, `${project}-ops-state`), beacon: new GcsBeaconStore(gcs, `${project}-mode-beacon`) };
}

export async function main(argv: readonly string[], signal: AbortSignal = new AbortController().signal): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "plan-guard") {
      const { values: a } = parseArgs({
        args: [...rest],
        strict: true,
        options: { "plan-json": { type: "string" }, mode: { type: "string" }, "allow-destroy": { type: "boolean", default: false } },
      });
      const mode = need(a.mode, "--mode");
      if (!["NORMAL", "STOPPED", "STARTING", "STOPPING", "UNKNOWN"].includes(mode)) throw new UsageError(`--mode が不正: ${mode}`);
      const problems = planGuard.check(loadJson(need(a["plan-json"], "--plan-json")), mode, a["allow-destroy"]);
      for (const p of problems) console.log(`::error::${p}`);
      console.log(`plan-guard: ${problems.length > 0 ? "NG" : "OK"}`);
      return problems.length > 0 ? 3 : 0;
    }
    if (cmd === "mode") {
      const { values: a } = parseArgs({ args: [...rest], strict: true, options: { project: { type: "string" } } });
      const { raw } = await stores(need(a.project, "--project")).state.read();
      let mode = "UNKNOWN";
      if (raw !== undefined) {
        try {
          mode = S.validate(raw).mode;
        } catch {
          mode = "UNKNOWN"; // 不正な状態は UNKNOWN（ガードが apply を拒否する）
        }
      }
      console.log(mode);
      return 0;
    }
    if (cmd === "status") {
      const { values: a } = parseArgs({ args: [...rest], strict: true, options: { project: { type: "string" }, region: COMMON.region } });
      const project = need(a.project, "--project");
      const { raw } = await stores(project).state.read();
      const rows = await collect(
        raw === undefined ? undefined : S.validate(raw),
        new GcloudAdapter(project, a.region, spawnRunner, undefined, undefined, signal),
      );
      console.log(render(rows));
      return hasProblem(rows) ? 1 : 0;
    }
    if (cmd === "deploy") {
      const { values: a } = parseArgs({
        args: [...rest],
        strict: true,
        options: {
          // deploy には dry-run・force が無い（受け付けて黙って無視すると、dry-run のつもりで本番を更新してしまう）
          project: COMMON.project,
          region: COMMON.region,
          kid: COMMON.kid,
          actor: COMMON.actor,
          "run-id": COMMON["run-id"],
          "run-url": COMMON["run-url"],
          reason: COMMON.reason,
          manifest: { type: "string" },
          schema: { type: "string" },
          "allow-when-stopped": { type: "boolean", default: false },
          "no-migrations": { type: "boolean", default: false },
        },
      });
      const project = need(a.project, "--project");
      const actor = need(a.actor, "--actor");
      const runId = need(a["run-id"], "--run-id");
      const manifest = loadJson(need(a.manifest, "--manifest"));
      const schema = loadJson(need(a.schema, "--schema"));
      const st = stores(project);
      const gcp = new GcloudAdapter(project, a.region, spawnRunner, undefined, undefined, signal);
      // deploy はビーコンを書かないので署名鍵を読まない（sa-gha-deploy に鍵の権限を与えない）
      const ops = new Ops(
        st.state,
        st.beacon,
        gcp,
        systemClock,
        undefined,
        a.kid,
        (t, b) => console.log(`::notice title=${t}::${b}`),
        signal,
      );
      try {
        const out = await deploy(
          ops,
          manifest,
          schema,
          {
            project,
            allowWhenStopped: a["allow-when-stopped"],
            applyMigrations: !a["no-migrations"],
            actor,
            runId,
            runUrl: a["run-url"],
            reason: a.reason,
          },
          (s) => console.log(s),
        );
        console.log(JSON.stringify(out));
        return 0;
      } catch (e) {
        if (e instanceof DeployRejected) {
          console.log(`::error::deploy 拒否/失敗: ${e.message}`);
          return 3;
        }
        throw e;
      }
    }
    if (cmd === "start" || cmd === "stop") {
      const { values: a } = parseArgs({
        args: [...rest],
        strict: true,
        options: {
          ...COMMON,
          "apply-pending-migrations": { type: "boolean", default: false },
          "drain-timeout-min": { type: "string", default: "15" },
          "take-backup": { type: "boolean", default: false },
        },
      });
      if (!/^\d{1,3}$/.test(a["drain-timeout-min"])) throw new UsageError("--drain-timeout-min は 0〜999 の整数");
      const project = need(a.project, "--project");
      const actor = need(a.actor, "--actor"); // 引数の検査は外部（gcloud・GCS）に触れる前に終える
      const runId = need(a["run-id"], "--run-id");
      const st = stores(project);
      const gcp = new GcloudAdapter(project, a.region, spawnRunner, undefined, undefined, signal);
      const key = privateKeyFromSecret(await secret(project, "beacon-signing-key", signal));
      const ops = new Ops(st.state, st.beacon, gcp, systemClock, key, a.kid, (t, b) => console.log(`::notice title=${t}::${b}`), signal);
      const inputs = {
        actor,
        reason: a.reason,
        runId,
        runUrl: a["run-url"],
        force: a.force,
        dryRun: a["dry-run"],
        applyPendingMigrations: a["apply-pending-migrations"],
        drainTimeoutMin: Number(a["drain-timeout-min"]),
        takeBackup: a["take-backup"],
      };
      const out = cmd === "start" ? await ops.start(inputs) : await ops.stop(inputs);
      console.log(JSON.stringify("dryRun" in out ? out : { mode: ops.state.mode, seq: ops.state.seq }));
      return 0;
    }
    throw new UsageError(`未知のコマンド: ${String(cmd)}（start | stop | status | mode | deploy | plan-guard）`);
  } catch (e) {
    if (e instanceof UsageError || (e instanceof TypeError && "code" in e && String(e.code).startsWith("ERR_PARSE_ARGS"))) {
      console.error(e.message);
      return 2;
    }
    if (e instanceof S.Rejected) {
      console.log(`::error::拒否: ${e.message}`);
      return 3;
    }
    if (e instanceof StepFailed) {
      console.log(`::error::失敗: ${e.message}（STARTING/STOPPING のまま。原因を直して同じ操作を再実行すると続きから進む）`);
      return 1;
    }
    if (e instanceof Interrupted) {
      console.log(`::error::中断: ${e.message}（リースを解放し FAILED を記録した。同じ操作を再実行すると続きから進む）`);
      return 1;
    }
    console.log(`::error::予期しない失敗: ${errorMessage(e).slice(0, 300)}`);
    return 1;
  }
}

/** 実行時の入口。最初のシグナルで中断を要求し、2 回目以降は無視して解放処理を続ける。 */
export function installSignals(): AbortController {
  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (!ac.signal.aborted) ac.abort(sig);
    });
  }
  return ac;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const ac = installSignals();
  main(process.argv.slice(2), ac.signal).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(errorMessage(e));
      process.exitCode = 1;
    },
  );
}
