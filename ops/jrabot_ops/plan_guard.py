"""Terraform の apply 前ガード（OPERATIONS_DESIGN §8.2 / T5.5）。`terraform show -json <plan>` を検査し、運用モード・DB の起動状態・認証設定を意図せず変える変更を拒否する。

拒否するもの:
  1. Cloud SQL の `activation_policy` の変更（start/stop だけが変える）。
  2. Cloud Run service の `ingress` の変更、Scheduler の `paused` の変更（同上）。
  3. データを失い得る資源（Cloud SQL・バケット・Secret・Artifact Registry）の delete / replace。
  4. 認証を緩める変更: `allUsers` / `allAuthenticatedUsers` の追加（ingest の invoker とビーコンのバケットを除く）、IAP の無効化、IAP 許可メンバーの追加以外の主体の付与。
  5. ops-state が NORMAL でないのに DB・ユーザー・Cloud SQL の設定に触れる変更（停止中は DB の読取りも失敗し得る）。
許可の例外は引数で明示する（`allow_destroy` など）。誤検知より検知漏れを避ける（fail closed）。
"""
from __future__ import annotations

import json

PROTECTED_DESTROY = (
    "google_sql_database_instance",
    "google_sql_database",
    "google_sql_user",
    "google_storage_bucket",
    "google_secret_manager_secret",
    "google_artifact_registry_repository",
)
DB_TYPES = ("google_sql_database_instance", "google_sql_database", "google_sql_user")
PUBLIC_MEMBERS = ("allUsers", "allAuthenticatedUsers")
ALLOWED_PUBLIC = (
    ("google_cloud_run_v2_service_iam_member", "jra-bot-ingest"),  # ingest はアプリ認証（IAP の外）
    ("google_storage_bucket_iam_member", "mode-beacon"),  # ビーコン専用バケットの公開読取り
)


def _get(d, path):
    for p in path:
        if d is None:
            return None
        if isinstance(p, int):
            d = d[p] if isinstance(d, list) and len(d) > p else None
        else:
            d = d.get(p) if isinstance(d, dict) else None
    return d


def check(plan: dict, mode: str, allow_destroy: bool = False) -> list[str]:
    problems: list[str] = []
    for rc in plan.get("resource_changes", []):
        actions = rc.get("change", {}).get("actions", [])
        if actions == ["no-op"] or actions == ["read"]:
            continue
        addr, typ = rc.get("address", "?"), rc.get("type", "")
        before, after = rc["change"].get("before"), rc["change"].get("after")
        destructive = "delete" in actions
        if destructive and typ in PROTECTED_DESTROY and not allow_destroy:
            problems.append(f"{addr}: {typ} の削除/置換は拒否（データ・状態を失う）")
        if typ == "google_sql_database_instance" and before and after:
            if _get(before, ["settings", 0, "activation_policy"]) != _get(after, ["settings", 0, "activation_policy"]):
                problems.append(f"{addr}: activation_policy の変更は start/stop だけが行う")
        if typ == "google_cloud_run_v2_service" and before and after and before.get("ingress") != after.get("ingress"):
            problems.append(f"{addr}: ingress の変更は start/stop だけが行う")
        if typ == "google_cloud_scheduler_job" and before and after and before.get("paused") != after.get("paused"):
            problems.append(f"{addr}: Scheduler の paused の変更は start/stop だけが行う")
        if typ == "google_cloud_run_v2_service" and before and after and before.get("iap_enabled") and not after.get("iap_enabled"):
            problems.append(f"{addr}: IAP の無効化は拒否")
        if typ.endswith("_iam_member") or typ.endswith("_iam_binding"):
            members = [after.get("member")] if after and after.get("member") else (after or {}).get("members", [])
            before_members = [before.get("member")] if before and before.get("member") else (before or {}).get("members", [])
            for m in members or []:
                if m in PUBLIC_MEMBERS and m not in (before_members or []):
                    if not any(typ == t and key in addr + json.dumps(after) for t, key in ALLOWED_PUBLIC):
                        problems.append(f"{addr}: {m} への付与は拒否（認証を緩める）")
        if typ in DB_TYPES and mode != "NORMAL" and ("create" in actions or "update" in actions or destructive):
            problems.append(f"{addr}: mode={mode} の間は DB に触れる変更を適用しない（NORMAL のときだけ）")
    return problems


def load(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)
