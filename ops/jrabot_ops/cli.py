"""ワークフローから呼ぶ入口。`python -m jrabot_ops.cli <start|stop|status|plan-guard> ...`

認証は実行環境（GitHub Actions の WIF → sa-gha-ops）が与える。長期キーは受け取らない。ビーコンの署名鍵は Secret Manager から実行時に読み、ログに出さない。
終了コード: 0 成功 / 1 失敗（STARTING・STOPPING のまま残り得る。再実行で続きから）/ 2 引数・入力の誤り / 3 拒否（排他・遷移禁止・ガード）。
"""
from __future__ import annotations

import argparse
import json
import signal
import subprocess
import sys
import time

from . import plan_guard, state as S
from .beacon import private_key_from_secret
from .engine import Inputs, Ops, StepFailed
from .gcloud_adapter import GcloudAdapter, GcsBeaconStore, GcsStateStore
from .status import collect, has_problem, render


class SystemClock:
    def now(self) -> str:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)


def _secret(project: str, name: str) -> str:
    p = subprocess.run(["gcloud", "secrets", "versions", "access", "latest", f"--secret={name}", f"--project={project}"], capture_output=True, text=True, check=False)
    if p.returncode != 0:
        raise RuntimeError(f"Secret {name} を読めない")  # 出力（秘密の断片）は出さない
    return p.stdout


def _build(args, with_key: bool = True) -> tuple[Ops | None, GcloudAdapter, GcsStateStore]:
    from google.cloud import storage  # 遅延 import（plan-guard と試験では不要）

    client = storage.Client(project=args.project)
    store = GcsStateStore(client.bucket(f"{args.project}-ops-state"))
    beacon = GcsBeaconStore(client.bucket(f"{args.project}-mode-beacon"))
    gcp = GcloudAdapter(args.project, args.region)
    if not with_key:  # status は署名鍵に触れない（読み取り専用。不要な秘密を読まない）
        return None, gcp, store
    key = private_key_from_secret(_secret(args.project, "beacon-signing-key"))
    ops = Ops(store, beacon, gcp, SystemClock(), key, args.kid, notifier=lambda t, b: print(f"::notice title={t}::{b}"))
    return ops, gcp, store


def _inputs(a) -> Inputs:
    return Inputs(
        actor=a.actor, reason=a.reason or "", run_id=a.run_id, run_url=a.run_url or "", force=a.force, dry_run=a.dry_run,
        apply_pending_migrations=getattr(a, "apply_pending_migrations", False),
        drain_timeout_min=getattr(a, "drain_timeout_min", 15), take_backup=getattr(a, "take_backup", False),
    )


def _common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--project", required=True)
    p.add_argument("--region", default="asia-northeast1")
    p.add_argument("--kid", default="beacon-1")
    p.add_argument("--actor", required=True)
    p.add_argument("--run-id", required=True)
    p.add_argument("--run-url", default="")
    p.add_argument("--reason", default="")
    p.add_argument("--force", action="store_true")
    p.add_argument("--dry-run", action="store_true")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="jrabot_ops")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("start")
    _common(s)
    s.add_argument("--apply-pending-migrations", action="store_true")
    t = sub.add_parser("stop")
    _common(t)
    t.add_argument("--drain-timeout-min", type=int, default=15)
    t.add_argument("--take-backup", action="store_true")
    st = sub.add_parser("status")
    st.add_argument("--project", required=True)
    st.add_argument("--region", default="asia-northeast1")
    m = sub.add_parser("mode", help="ops-state の mode を 1 行で出す（無ければ UNKNOWN）")
    m.add_argument("--project", required=True)
    d = sub.add_parser("deploy")
    d.add_argument("--project", required=True)
    d.add_argument("--region", default="asia-northeast1")
    d.add_argument("--manifest", required=True)
    d.add_argument("--schema", required=True)
    d.add_argument("--allow-when-stopped", action="store_true")
    d.add_argument("--no-migrations", action="store_true")
    g = sub.add_parser("plan-guard")
    g.add_argument("--plan-json", required=True)
    g.add_argument("--mode", required=True, choices=["NORMAL", "STOPPED", "STARTING", "STOPPING", "UNKNOWN"])
    g.add_argument("--allow-destroy", action="store_true")
    a = ap.parse_args(argv)
    # GitHub Actions のキャンセルは SIGINT → SIGTERM。例外に変えて、リースの解放と FAILED の記録を行わせる
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt("SIGTERM")))

    if a.cmd == "plan-guard":
        problems = plan_guard.check(plan_guard.load(a.plan_json), a.mode, a.allow_destroy)
        for p in problems:
            print(f"::error::{p}")
        print("plan-guard: " + ("NG" if problems else "OK"))
        return 3 if problems else 0

    if a.cmd == "mode":
        from google.cloud import storage

        st, _ = GcsStateStore(storage.Client(project=a.project).bucket(f"{a.project}-ops-state")).read()
        print((st or {}).get("mode", "UNKNOWN"))
        return 0
    if a.cmd == "deploy":
        return _deploy(a)
    ops, gcp, store = _build(a if a.cmd != "status" else _StatusArgs(a), with_key=a.cmd != "status")
    if a.cmd == "status":
        state, _ = store.read()
        rows = collect(state, gcp)
        print(render(rows))
        return 1 if has_problem(rows) else 0
    try:
        (ops.start if a.cmd == "start" else ops.stop)(_inputs(a))
    except S.Rejected as e:
        print(f"::error::拒否: {e}")
        return 3
    except StepFailed as e:
        print(f"::error::失敗: {e}（STARTING/STOPPING のまま。原因を直して同じ操作を再実行すると続きから進む）")
        return 1
    print(json.dumps({"mode": ops.state.get("mode"), "seq": ops.state.get("seq")}, ensure_ascii=False))
    return 0


def _deploy(a) -> int:
    from google.cloud import storage

    from .deploy import DeployInputs, DeployRejected, deploy, load

    state, _ = GcsStateStore(storage.Client(project=a.project).bucket(f"{a.project}-ops-state")).read()
    mode = (state or {}).get("mode", "UNKNOWN")
    try:
        out = deploy(load(a.manifest), load(a.schema), mode, GcloudAdapter(a.project, a.region), DeployInputs(a.project, a.allow_when_stopped, not a.no_migrations))
    except DeployRejected as e:
        print(f"::error::deploy 拒否/失敗: {e}")
        return 3
    print(json.dumps(out, ensure_ascii=False))
    return 0


class _StatusArgs:
    def __init__(self, a) -> None:
        self.project, self.region, self.kid = a.project, a.region, "beacon-1"


if __name__ == "__main__":
    sys.exit(main())
