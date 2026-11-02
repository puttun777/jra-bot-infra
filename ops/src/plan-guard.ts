/**
 * Terraform の apply 前ガード（OPERATIONS_DESIGN §8.2 / T5.5）。`terraform show -json <plan>` を検査し、運用モード・DB の起動状態・認証設定を
 * 意図せず変える変更を拒否する。旧 plan_guard.py の移植（Pulumi への移行（L6）までの間だけ使う。Pulumi 用は preview-guard.ts）。
 * 誤検知より検知漏れを避ける（fail closed）。plan の形式が想定と違えば拒否する。
 */
import { isRecord } from "./json.js";

export const PROTECTED_DESTROY: ReadonlySet<string> = new Set([
  "google_sql_database_instance",
  "google_sql_database",
  "google_sql_user",
  "google_storage_bucket",
  "google_secret_manager_secret",
  "google_artifact_registry_repository",
]);
const DB_TYPES: ReadonlySet<string> = new Set(["google_sql_database_instance", "google_sql_database", "google_sql_user"]);
const PUBLIC_MEMBERS: ReadonlySet<string> = new Set(["allUsers", "allAuthenticatedUsers"]);
const ALLOWED_PUBLIC: readonly (readonly [string, string])[] = [
  ["google_cloud_run_v2_service_iam_member", "jra-bot-ingest"], // ingest はアプリ認証（IAP の外）
  ["google_storage_bucket_iam_member", "mode-beacon"], // ビーコン専用バケットの公開読取り
];
const STABLE_MODES: ReadonlySet<string> = new Set(["NORMAL", "STOPPED"]);
const IAP_ACCESSOR_TYPES: ReadonlySet<string> = new Set([
  "google_iap_web_cloud_run_service_iam_member",
  "google_iap_web_cloud_run_service_iam_binding",
]);

function get(d: unknown, path: readonly (string | number)[]): unknown {
  let cur = d;
  for (const p of path) {
    if (typeof p === "number") cur = Array.isArray(cur) ? cur[p] : undefined;
    else cur = isRecord(cur) ? cur[p] : undefined;
    if (cur === undefined) return undefined;
  }
  return cur;
}

export function members(d: unknown): string[] {
  if (!isRecord(d)) return [];
  if (typeof d["member"] === "string" && d["member"] !== "") return [d["member"]];
  if (Array.isArray(d["members"]) && d["members"].length > 0) return d["members"].map(String);
  const pd = d["policy_data"];
  if (typeof pd === "string") {
    try {
      const policy: unknown = JSON.parse(pd);
      const bindings = isRecord(policy) && Array.isArray(policy["bindings"]) ? policy["bindings"] : [];
      return bindings.flatMap((b) => (isRecord(b) && Array.isArray(b["members"]) ? b["members"].map(String) : []));
    } catch {
      return ["<unparseable policy_data>"];
    }
  }
  return [];
}

function actionsOf(rc: Record<string, unknown>): string[] {
  const a = get(rc, ["change", "actions"]);
  return Array.isArray(a) ? a.map(String) : ["<unknown>"];
}

export function check(plan: unknown, mode: string, allowDestroy = false): string[] {
  if (!isRecord(plan) || !(Array.isArray(plan["resource_changes"]) || plan["resource_changes"] === undefined))
    return ["plan の JSON の形式が想定と違う（検査できないので拒否）"];
  const rcs = (Array.isArray(plan["resource_changes"]) ? plan["resource_changes"] : []).filter(isRecord);
  const problems: string[] = [];
  const isNoop = (a: string[]): boolean => a.length === 1 && (a[0] === "no-op" || a[0] === "read");
  const changing = rcs.filter((rc) => !isNoop(actionsOf(rc)));
  if (changing.length > 0 && !STABLE_MODES.has(mode))
    problems.push(`mode=${mode} の間は apply しない（start/stop の完了後に。ガードは変更 ${changing.length} 件を拒否）`);
  const KNOWN_ACTIONS = new Set(["no-op", "create", "read", "update", "delete"]);
  for (const rc of rcs) {
    const actions = actionsOf(rc);
    if (isNoop(actions)) continue;
    if (actions.length === 0 || actions.some((x) => !KNOWN_ACTIONS.has(x))) {
      problems.push(
        `${typeof rc["address"] === "string" ? rc["address"] : "?"}: 変更の種類を判別できない（${JSON.stringify(actions)}。検査できないので拒否）`,
      );
      continue;
    }
    const addr = typeof rc["address"] === "string" ? rc["address"] : "?";
    const typ = typeof rc["type"] === "string" ? rc["type"] : "";
    const before = get(rc, ["change", "before"]);
    const after = get(rc, ["change", "after"]);
    const b = isRecord(before) ? before : undefined;
    const a = isRecord(after) ? after : undefined;
    const destructive = actions.includes("delete");
    if (destructive && PROTECTED_DESTROY.has(typ) && !allowDestroy)
      problems.push(`${addr}: ${typ} の削除/置換は拒否（データ・状態を失う）`);
    if (typ === "google_sql_database_instance" && b && a) {
      if (get(b, ["settings", 0, "activation_policy"]) !== get(a, ["settings", 0, "activation_policy"]))
        problems.push(`${addr}: activation_policy の変更は start/stop だけが行う`);
    }
    if (typ === "google_cloud_run_v2_service" && b && a && b["ingress"] !== a["ingress"])
      problems.push(`${addr}: ingress の変更は start/stop だけが行う`);
    if (typ === "google_cloud_scheduler_job" && b && a && b["paused"] !== a["paused"])
      problems.push(`${addr}: Scheduler の paused の変更は start/stop だけが行う`);
    if (typ === "google_cloud_run_v2_service" && b && a && b["iap_enabled"] === true && a["iap_enabled"] !== true)
      problems.push(`${addr}: IAP の無効化は拒否`);
    if (typ === "google_cloud_run_v2_service" && a) {
      if (
        actions.includes("create") &&
        a["ingress"] !== undefined &&
        a["ingress"] !== null &&
        a["ingress"] !== "INGRESS_TRAFFIC_INTERNAL_ONLY"
      ) {
        problems.push(`${addr}: 作成時の ingress は INGRESS_TRAFFIC_INTERNAL_ONLY であること（停止側の初期値）`);
      }
      if (a["invoker_iam_disabled"] === true && b?.["invoker_iam_disabled"] !== true)
        problems.push(`${addr}: invoker_iam_disabled=true は拒否（IAM 認証を外す）`);
    }
    if (typ === "google_cloud_scheduler_job" && actions.includes("create") && a && a["paused"] === false)
      problems.push(`${addr}: Scheduler は paused=true で作る（再開は ops-start だけ）`);
    if (IAP_ACCESSOR_TYPES.has(typ)) {
      for (const m of members(after)) {
        if (!(m.startsWith("user:") || m.startsWith("serviceAccount:")))
          problems.push(`${addr}: IAP の許可に user:/serviceAccount: 以外の主体 ${m} は拒否`);
      }
    }
    if (typ.endsWith("_iam_member") || typ.endsWith("_iam_binding") || typ.endsWith("_iam_policy")) {
      const unknown = get(rc, ["change", "after_unknown"]);
      if (isRecord(unknown) && ["member", "members", "policy_data"].some((k) => Boolean(unknown[k])))
        problems.push(`${addr}: IAM の主体が plan の時点で未確定（検査できないので拒否）`);
      const beforeMembers = new Set(members(before));
      for (const m of members(after)) {
        if (PUBLIC_MEMBERS.has(m) && !beforeMembers.has(m)) {
          const text = addr + JSON.stringify(after);
          if (!ALLOWED_PUBLIC.some(([t, key]) => typ === t && text.includes(key)))
            problems.push(`${addr}: ${m} への付与は拒否（認証を緩める）`);
        }
      }
    }
    if (DB_TYPES.has(typ) && mode !== "NORMAL" && (actions.includes("create") || actions.includes("update") || destructive)) {
      problems.push(`${addr}: mode=${mode} の間は DB に触れる変更を適用しない（NORMAL のときだけ）`);
    }
  }
  return problems;
}
