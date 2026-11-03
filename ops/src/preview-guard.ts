/**
 * Pulumi の preview のガード（Terraform の plan-guard と同じ規則。docs/PULUMI_MIGRATION.md §4）。`pulumi preview --json` の出力を検査し、
 * 運用モード・DB の起動状態・認証設定・データを意図せず変える変更、秘密を state に載せる変更を拒否する。
 * 誤検知より検知漏れを避ける（fail closed）: 形式が想定と違う・変更の種類を判別できない・値が preview の時点で未確定なら拒否する。
 */
import { isRecord } from "./json.js";

/** 削除・置換を拒否する型（データ・状態を失う）。 */
export const PROTECTED_DESTROY: ReadonlySet<string> = new Set([
  "gcp:sql/databaseInstance:DatabaseInstance",
  "gcp:sql/database:Database",
  "gcp:storage/bucket:Bucket",
  "gcp:secretmanager/secret:Secret",
  "gcp:artifactregistry/repository:Repository",
]);
/** Pulumi が管理してはならない型（秘密の値・DB ユーザーのパスワードを state に載せない: §3）。 */
export const FORBIDDEN_TYPES: ReadonlySet<string> = new Set(["gcp:sql/user:User", "gcp:secretmanager/secretVersion:SecretVersion"]);
const DB_TYPES: ReadonlySet<string> = new Set(["gcp:sql/databaseInstance:DatabaseInstance", "gcp:sql/database:Database"]);
const SERVICE = "gcp:cloudrunv2/service:Service";
const SCHEDULER = "gcp:cloudscheduler/job:Job";
const SQL = "gcp:sql/databaseInstance:DatabaseInstance";
const IAP_ACCESSOR_TYPES: ReadonlySet<string> = new Set(["gcp:iap/webCloudRunServiceIamMember:WebCloudRunServiceIamMember"]);
const PUBLIC_MEMBERS: ReadonlySet<string> = new Set(["allUsers", "allAuthenticatedUsers"]);
/** 公開の主体を許す資源（論理名）。ingest はアプリ認証（IAP の外）、ビーコン専用バケットの公開読取り。 */
const ALLOWED_PUBLIC: readonly (readonly [string, string])[] = [
  ["gcp:cloudrunv2/serviceIamMember:ServiceIamMember", "ingest-public-invoker"],
  ["gcp:storage/bucketIAMMember:BucketIAMMember", "beacon-public-read"],
];
const STABLE_MODES: ReadonlySet<string> = new Set(["NORMAL", "STOPPED"]);
const KNOWN_OPS: ReadonlySet<string> = new Set([
  "same",
  "create",
  "update",
  "delete",
  "replace",
  "create-replacement",
  "delete-replaced",
  "read",
  "refresh",
]);
const NOOP_OPS: ReadonlySet<string> = new Set(["same", "read", "refresh"]);
const DESTRUCTIVE_OPS: ReadonlySet<string> = new Set(["delete", "replace", "create-replacement", "delete-replaced"]);
/** preview の時点で値が確定していない印（Pulumi の UnknownStringValue）。 */
const UNKNOWN = "04da6b54-80e4-46f7-96ec-b56ff0331ba9";
/** Pulumi の秘密の値の印（state で暗号化される値）。 */
const SECRET_SIG = "4dabf18193072939515e22adb298388d";

function get(d: unknown, path: readonly string[]): unknown {
  let cur = d;
  for (const p of path) {
    cur = isRecord(cur) ? cur[p] : undefined;
    if (cur === undefined) return undefined;
  }
  return cur;
}

function containsSecret(v: unknown): boolean {
  if (isRecord(v)) return v[SECRET_SIG] !== undefined || Object.values(v).some(containsSecret);
  if (Array.isArray(v)) return v.some(containsSecret);
  return false;
}

/** URN の最後の 2 要素（型・論理名）。 */
function parseUrn(urn: string): { type: string; name: string } | undefined {
  const parts = urn.split("::");
  if (parts.length < 4 || !urn.startsWith("urn:pulumi:")) return undefined;
  const typePath = parts[2] ?? "";
  const type = typePath.split("$").pop() ?? "";
  const name = parts.slice(3).join("::");
  return type !== "" && name !== "" ? { type, name } : undefined;
}

export function check(preview: unknown, mode: string, allowDestroy = false): string[] {
  if (!isRecord(preview) || !(Array.isArray(preview["steps"]) || preview["steps"] === undefined))
    return ["preview の JSON の形式が想定と違う（検査できないので拒否）"];
  const steps = Array.isArray(preview["steps"]) ? preview["steps"] : [];
  const problems: string[] = [];
  const changing = steps.filter((s) => !(isRecord(s) && typeof s["op"] === "string" && NOOP_OPS.has(s["op"])));
  if (changing.length > 0 && !STABLE_MODES.has(mode))
    problems.push(`mode=${mode} の間は up しない（start/stop の完了後に。ガードは変更 ${changing.length} 件を拒否）`);
  for (const s of steps) {
    if (!isRecord(s) || typeof s["op"] !== "string" || typeof s["urn"] !== "string") {
      problems.push("preview の step の形式が想定と違う（検査できないので拒否）");
      continue;
    }
    const op = s["op"];
    const id = parseUrn(s["urn"]);
    if (id === undefined) {
      problems.push(`${s["urn"]}: URN を解釈できない（検査できないので拒否）`);
      continue;
    }
    const { type, name } = id;
    const addr = `${type}::${name}`;
    if (!KNOWN_OPS.has(op)) {
      problems.push(`${addr}: 変更の種類 ${op} を判別できない（検査できないので拒否）`);
      continue;
    }
    if (type === "pulumi:pulumi:Stack" || type.startsWith("pulumi:providers:")) {
      if (DESTRUCTIVE_OPS.has(op) && type.startsWith("pulumi:providers:") && !allowDestroy)
        problems.push(`${addr}: プロバイダの置換は拒否（全資源の置換につながる）`);
      continue;
    }
    if (NOOP_OPS.has(op)) continue;
    const before = get(s, ["oldState", "inputs"]);
    const after = get(s, ["newState", "inputs"]);
    const b = isRecord(before) ? before : undefined;
    const a = isRecord(after) ? after : undefined;
    if (FORBIDDEN_TYPES.has(type)) problems.push(`${addr}: ${type} は Pulumi で管理しない（秘密を state に載せない）`);
    if (a !== undefined && containsSecret(a)) problems.push(`${addr}: 秘密の値を state に載せる変更は拒否（PULUMI_MIGRATION §3）`);
    if (DESTRUCTIVE_OPS.has(op) && PROTECTED_DESTROY.has(type) && !allowDestroy)
      problems.push(`${addr}: ${type} の削除/置換は拒否（データ・状態を失う）`);
    if (type === SQL && b && a && get(b, ["settings", "activationPolicy"]) !== get(a, ["settings", "activationPolicy"]))
      problems.push(`${addr}: activationPolicy の変更は start/stop だけが行う`);
    if (type === SERVICE && b && a && b["ingress"] !== a["ingress"]) problems.push(`${addr}: ingress の変更は start/stop だけが行う`);
    if (type === SCHEDULER && b && a && b["paused"] !== a["paused"])
      problems.push(`${addr}: Scheduler の paused の変更は start/stop だけが行う`);
    if (type === SERVICE && b && a && b["iapEnabled"] === true && a["iapEnabled"] !== true) problems.push(`${addr}: IAP の無効化は拒否`);
    if (type === SERVICE && a) {
      if (op === "create" && a["ingress"] !== undefined && a["ingress"] !== "INGRESS_TRAFFIC_INTERNAL_ONLY")
        problems.push(`${addr}: 作成時の ingress は INGRESS_TRAFFIC_INTERNAL_ONLY であること（停止側の初期値）`);
      if (a["invokerIamDisabled"] === true && b?.["invokerIamDisabled"] !== true)
        problems.push(`${addr}: invokerIamDisabled=true は拒否（IAM 認証を外す）`);
    }
    if (type === SCHEDULER && op === "create" && a && a["paused"] === false)
      problems.push(`${addr}: Scheduler は paused=true で作る（再開は ops-start だけ）`);
    const isIam = /IamMember:|IAMMember:|IamBinding:|IAMBinding:|IamPolicy:|IAMPolicy:/.test(type);
    if (isIam && a) {
      const m = a["member"];
      if (m === UNKNOWN || typeof m !== "string") problems.push(`${addr}: IAM の主体が preview の時点で未確定（検査できないので拒否）`);
      else {
        if (PUBLIC_MEMBERS.has(m) && b?.["member"] !== m && !ALLOWED_PUBLIC.some(([t, n]) => t === type && n === name))
          problems.push(`${addr}: ${m} への付与は拒否（認証を緩める）`);
        if (IAP_ACCESSOR_TYPES.has(type) && !(m.startsWith("user:") || m.startsWith("serviceAccount:")))
          problems.push(`${addr}: IAP の許可に user:/serviceAccount: 以外の主体 ${m} は拒否`);
      }
    }
    if (DB_TYPES.has(type) && mode !== "NORMAL")
      problems.push(`${addr}: mode=${mode} の間は DB に触れる変更を適用しない（NORMAL のときだけ）`);
  }
  return problems;
}
