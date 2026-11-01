"""deploy（イメージ更新）。入力は release-manifest だけ（web CONTRACTS §10 / infra I-H3・I-H9）。

順序: ① manifest 検証（スキーマ・プロジェクトの一致・digest 固定）→ ② 運用モードの確認（NORMAL 以外は既定で拒否。STOPPED で許すのはイメージ参照の更新だけで、migration は実行しない）
→ ③ db-migration Job のイメージ更新 → validate（終了コード 0/10/1/75）→ 10 なら migrate → 再 validate が 0 であること → ④ 各 Job のイメージ更新 → ⑤ ingest → dashboard のイメージ更新
→ ⑥ ヘルスチェック → ⑦ ingress・IAP が deploy の前後で変わっていないこと。**マイグレーションがアプリより先**。失敗した段階で止め、後続は実行しない。
deploy は ingress・IAP・Scheduler・運用モード・DB の起動状態を変更しない（それらは ops の start/stop だけ）。
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

from . import schema_lite
from .engine import SERVICES
from .ports import Gcp

BOT_JOBS = ("jra-bot-bot-run", "jra-bot-calendar-check", "jra-bot-reconcile", "jra-bot-retention")
DB_JOB = "jra-bot-db-migration"
ML_JOB = "jra-bot-ml-train"
CONTRACT_MAJOR_MINOR = "0.4"


class DeployRejected(Exception):
    pass


@dataclass
class DeployInputs:
    project: str
    allow_when_stopped: bool = False
    apply_migrations: bool = True


def check_manifest(manifest: dict, schema: dict, project: str) -> list[str]:
    problems = list(schema_lite.validate(manifest, schema))
    if problems:
        return problems
    if "kind" in manifest or manifest.get("deployable") is False:
        problems.append("プレビュー manifest は deploy に使えない")
    prefix = f"asia-northeast1-docker.pkg.dev/{project}/jra-bot/"
    for name, ref in manifest["images"].items():
        if not ref.startswith(prefix):
            problems.append(f"images.{name} がこのプロジェクト({project})の Artifact Registry ではない")
        if not re.search(r"@sha256:[0-9a-f]{64}$", ref):
            problems.append(f"images.{name} が digest 固定ではない")
    if not manifest["contract_version"].startswith(CONTRACT_MAJOR_MINOR + "."):
        problems.append(f"contract_version {manifest['contract_version']} は deploy が対応する {CONTRACT_MAJOR_MINOR}.x ではない")
    return problems


def deploy(manifest: dict, schema: dict, mode: str, gcp: Gcp, i: DeployInputs, log=print) -> dict:
    problems = check_manifest(manifest, schema, i.project)
    if problems:
        raise DeployRejected("manifest 不正: " + " / ".join(problems))
    if mode in ("STARTING", "STOPPING", "UNKNOWN"):
        raise DeployRejected(f"mode={mode} の間は deploy しない（start/stop の完了後に実行）")
    migrate = mode == "NORMAL" and i.apply_migrations
    if mode == "STOPPED" and not i.allow_when_stopped:
        raise DeployRejected("mode=STOPPED の deploy は既定で拒否（allow_when_stopped=true でイメージ参照の更新だけ。migration は実行しない）")
    before = {n: (gcp.service_state(n).get("ingress"), gcp.service_state(n).get("iap_enabled")) for n in SERVICES}
    img = manifest["images"]
    done: list[str] = []
    if mode == "NORMAL":
        gcp.job_set_image(DB_JOB, img["db-migration"])
        code = gcp.run_job(DB_JOB, ["--mode=validate"])
        if code == 10:
            if not migrate:
                raise DeployRejected("未適用のマイグレーションがある（apply_migrations=true で実行）")
            log("未適用のマイグレーションを適用する")
            if gcp.run_job(DB_JOB, ["--mode=migrate"]) != 0:
                raise DeployRejected("migrate が失敗（アプリは更新していない）")
            code = gcp.run_job(DB_JOB, ["--mode=validate"])
        if code != 0:
            raise DeployRejected(f"db-migration validate が終了コード {code}（0 以外。アプリは更新していない。1=不一致/失敗版、75=DB 不達）")
        done.append("migration")
    else:
        gcp.job_set_image(DB_JOB, img["db-migration"])
    for j in BOT_JOBS:
        gcp.job_set_image(j, img["bot"])
    gcp.job_set_image(ML_JOB, img["ml-train"])
    done.append("jobs")
    for name, key in zip(SERVICES, ("ingest", "dashboard")):
        gcp.service_set_image(name, img[key])
        done.append(name)
    if mode == "NORMAL":
        for name in SERVICES:
            code = gcp.service_health(name, "/internal/ready")
            if code != 200:
                raise DeployRejected(f"{name} のヘルスチェックが {code}（ロールバックは手順書。mode は変更していない）")
    after = {n: (gcp.service_state(n).get("ingress"), gcp.service_state(n).get("iap_enabled")) for n in SERVICES}
    if after != before:
        raise DeployRejected(f"deploy の前後で ingress/IAP が変わった: {before} → {after}")
    return {"release": manifest["release"], "git_sha": manifest["git_sha"], "mode": mode, "done": done}


def load(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)
