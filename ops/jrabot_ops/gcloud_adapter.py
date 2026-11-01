"""本番のアダプタ（gcloud CLI / GCS クライアント）。**実 GCP では未検証**（検証ゲート G-OPS-1〜9。OPERATIONS_DESIGN §12）。コマンドの組み立てと出力の解釈は
`tests/test_adapters.py` が偽の実行器で検査するが、実際の GCP の応答との一致は保証しない。"""
from __future__ import annotations

import json
import re
import subprocess
import urllib.error
import urllib.request
from typing import Callable

from .ports import ConflictError

Runner = Callable[[list[str]], tuple[int, str]]


def subprocess_runner(cmd: list[str]) -> tuple[int, str]:
    p = subprocess.run(cmd, capture_output=True, text=True, check=False)
    return p.returncode, (p.stdout if p.returncode == 0 else p.stdout + p.stderr)


class GcloudAdapter:
    def __init__(self, project: str, region: str, runner: Runner = subprocess_runner, http_get=None, id_token=None) -> None:
        self.project, self.region, self.run = project, region, runner
        self._http_get = http_get or self._default_http_get
        self._id_token = id_token or self._default_id_token

    # ---- 共通
    def _json(self, cmd: list[str]):
        code, out = self.run(cmd + ["--format=json", f"--project={self.project}"])
        if code != 0:
            raise RuntimeError(f"gcloud 失敗: {' '.join(cmd[:4])}: {out[-200:]}")
        return json.loads(out or "null")

    def _ok(self, cmd: list[str]) -> None:
        code, out = self.run(cmd + [f"--project={self.project}", "--quiet"])
        if code != 0:
            raise RuntimeError(f"gcloud 失敗: {' '.join(cmd[:4])}: {out[-200:]}")

    # ---- Cloud SQL
    def sql_state(self) -> dict:
        d = self._json(["gcloud", "sql", "instances", "describe", "jra-bot-db"])
        return {
            "state": d.get("state"),
            "activation_policy": (d.get("settings") or {}).get("activationPolicy"),
            "edition": (d.get("settings") or {}).get("edition"),
            "version": d.get("databaseVersion"),
        }

    def sql_set_activation(self, policy: str) -> None:
        if policy not in ("ALWAYS", "NEVER"):
            raise ValueError(policy)
        self._ok(["gcloud", "sql", "instances", "patch", "jra-bot-db", f"--activation-policy={policy}"])

    def sql_backup(self) -> None:
        self._ok(["gcloud", "sql", "backups", "create", "--instance=jra-bot-db"])

    # ---- Cloud Run service
    def service_state(self, name: str) -> dict:
        d = self._json(["gcloud", "run", "services", "describe", name, f"--region={self.region}"])
        ann = (d.get("metadata") or {}).get("annotations") or {}
        conds = {c.get("type"): c.get("status") for c in (d.get("status") or {}).get("conditions", [])}
        iap = ann.get("run.googleapis.com/iap-enabled") == "true" or (d.get("spec", {}).get("template", {}).get("metadata", {}).get("annotations", {}).get("run.googleapis.com/iap-enabled") == "true")
        members = 0
        if name.endswith("dashboard"):
            try:
                pol = self._json(["gcloud", "iap", "web", "get-iam-policy", "--resource-type=cloud-run", f"--service={name}", f"--region={self.region}"])
                members = sum(len(b.get("members", [])) for b in (pol or {}).get("bindings", []) if b.get("role") == "roles/iap.httpsResourceAccessor")
            except RuntimeError:
                members = 0
        return {
            "ingress": ann.get("run.googleapis.com/ingress", "all"),
            "ready": conds.get("Ready") == "True",
            "iap_enabled": iap,
            "iap_members": members,
            "url": (d.get("status") or {}).get("url", ""),
        }

    def service_set_ingress(self, name: str, ingress: str) -> None:
        if ingress not in ("all", "internal"):
            raise ValueError(ingress)
        self._ok(["gcloud", "run", "services", "update", name, f"--region={self.region}", f"--ingress={ingress}"])

    def _default_http_get(self, url: str, token: str | None) -> int:
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"} if token else {})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:  # noqa: S310 - https の Cloud Run の URL だけ
                return r.status
        except urllib.error.HTTPError as e:
            return e.code
        except (urllib.error.URLError, TimeoutError):
            return 0

    def _default_id_token(self, audience: str) -> str:
        code, out = self.run(["gcloud", "auth", "print-identity-token", f"--audience={audience}"])
        if code != 0:
            raise RuntimeError("ID トークンを取得できない")
        return out.strip()

    def service_health(self, name: str, path: str) -> int:
        url = self.service_state(name)["url"]
        if not url:
            return 0
        return self._http_get(url + path, self._id_token(url))

    def service_reachable_externally(self, name: str) -> bool:
        url = self.service_state(name)["url"]
        code = self._http_get(url + "/", None) if url else 0
        return code not in (0, 403, 404)  # ingress=internal は Google のフロントが 404/403 を返す

    # ---- Cloud Run Jobs
    def running_executions(self) -> list[str]:
        d = self._json(["gcloud", "run", "jobs", "executions", "list", f"--region={self.region}"]) or []
        # 『完了時刻が無い』ものを実行中として数える（runningCount だけだと、開始待ち・イメージ取得中を見落とす）。
        out = []
        for e in d:
            st = e.get("status") or {}
            if not st.get("completionTime") and not any(c.get("type") == "Completed" and c.get("status") in ("True", "False") for c in st.get("conditions", [])):
                out.append(e["metadata"]["name"])
        return out

    def cancel_execution(self, execution: str) -> None:
        self._ok(["gcloud", "run", "jobs", "executions", "cancel", execution, f"--region={self.region}"])

    def run_job(self, job: str, args: list[str]) -> int:
        cmd = ["gcloud", "run", "jobs", "execute", job, f"--region={self.region}", "--wait", f"--args={','.join(args)}", f"--project={self.project}", "--quiet"]
        code, out = self.run(cmd)
        if code == 0:
            return 0
        m = re.search(r"exit\((\d+)\)", out)
        if m:
            return int(m.group(1))
        # 出力に終了コードが無い場合は、直近の execution の記述から探す（形式は実 GCP で未確認: G-OPS-10）。見つからなければ 1（fail closed）
        try:
            d = self._json(["gcloud", "run", "jobs", "executions", "list", f"--job={job}", f"--region={self.region}", "--limit=1"]) or []
            m = re.search(r"exit\((\d+)\)", json.dumps(d))
            if m:
                return int(m.group(1))
        except RuntimeError:
            pass
        return 1

    def job_set_image(self, job: str, image: str) -> None:
        """deploy 用。イメージだけを更新する（環境変数・Secret・args・実行はしない）。"""
        self._ok(["gcloud", "run", "jobs", "update", job, f"--region={self.region}", f"--image={image}"])

    def service_set_image(self, name: str, image: str) -> None:
        """deploy 用。イメージだけを更新する（ingress・IAP・IAM には触れない）。"""
        self._ok(["gcloud", "run", "services", "update", name, f"--region={self.region}", f"--image={image}"])

    # ---- Scheduler
    def scheduler_states(self) -> dict[str, str]:
        d = self._json(["gcloud", "scheduler", "jobs", "list", f"--location={self.region}"]) or []
        return {j["name"].rsplit("/", 1)[-1]: j.get("state", "?") for j in d}

    def scheduler_pause(self, name: str) -> None:
        self._ok(["gcloud", "scheduler", "jobs", "pause", name, f"--location={self.region}"])

    def scheduler_resume(self, name: str) -> None:
        self._ok(["gcloud", "scheduler", "jobs", "resume", name, f"--location={self.region}"])


class GcsStateStore:
    """GCS の ops-state（CAS = ifGenerationMatch）。`bucket` は google-cloud-storage の Bucket 互換（試験では偽物）。"""

    STATE = "state/ops-state.json"

    def __init__(self, bucket) -> None:
        self.bucket = bucket

    def read(self):
        blob = self.bucket.get_blob(self.STATE)
        if blob is None:
            return None, 0
        return json.loads(blob.download_as_bytes().decode("utf-8")), int(blob.generation)

    def write(self, state: dict, if_generation: int) -> int:
        blob = self.bucket.blob(self.STATE)
        try:
            blob.upload_from_string(json.dumps(state, ensure_ascii=False, sort_keys=True, indent=1), content_type="application/json", if_generation_match=if_generation)
        except Exception as e:  # noqa: BLE001 - 412 PreconditionFailed を競合として扱う
            if "412" in str(e) or "Precondition" in str(e):
                raise ConflictError(str(e)) from e
            raise
        return int(blob.generation)

    def append_history(self, name: str, state: dict) -> None:
        blob = self.bucket.blob(f"history/{name}.json")
        blob.upload_from_string(json.dumps(state, ensure_ascii=False, sort_keys=True), content_type="application/json", if_generation_match=0)


class GcsBeaconStore:
    OBJECT = "beacon/mode.json"

    def __init__(self, bucket) -> None:
        self.bucket = bucket

    def write(self, raw: bytes) -> None:
        blob = self.bucket.blob(self.OBJECT)
        blob.cache_control = "no-store"
        blob.upload_from_string(raw, content_type="application/json")

