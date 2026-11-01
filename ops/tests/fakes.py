from __future__ import annotations

import copy
import json

from jrabot_ops.ports import ConflictError


class FakeStore:
    def __init__(self, state=None):
        self.state, self.gen = (copy.deepcopy(state), 1) if state else (None, 0)
        self.history: list[str] = []
        self.fail_after_writes: int | None = None
        self.writes = 0
        self.conflict_next = False

    def read(self):
        return copy.deepcopy(self.state), self.gen

    def write(self, state, if_generation):
        if self.conflict_next:
            self.conflict_next = False
            raise ConflictError("412")
        if if_generation != self.gen:
            raise ConflictError("412")
        self.writes += 1
        if self.fail_after_writes is not None and self.writes > self.fail_after_writes:
            raise RuntimeError("GCS が書けない")
        self.state, self.gen = copy.deepcopy(state), self.gen + 1
        return self.gen

    def append_history(self, name, state):
        self.history.append(name)


class FakeBeacon:
    def __init__(self):
        self.writes: list[dict] = []

    def write(self, raw: bytes):
        self.writes.append(json.loads(raw))


class FakeClock:
    def __init__(self):
        self.t = 0
        self.sleeps: list[float] = []

    def now(self):
        return f"2026-11-01T10:{self.t // 60:02d}:{self.t % 60:02d}Z"

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.t += int(seconds)


class FakeGcp:
    """実 GCP の代わりの状態機械（試験用）。呼び出しの順序を `calls` に残す。"""

    def __init__(self):
        self.sql = {"state": "STOPPED", "activation_policy": "NEVER"}
        self.sql_up_after = 0  # 起動に要する sql_state の呼出し回数
        self._polls = 0
        self.services = {
            "jra-bot-ingest": {"ingress": "internal", "ready": True, "iap_enabled": False, "iap_members": 0, "url": "https://ingest"},
            "jra-bot-dashboard": {"ingress": "internal", "ready": True, "iap_enabled": True, "iap_members": 1, "url": "https://dash"},
        }
        self.health = {"jra-bot-ingest": 200, "jra-bot-dashboard": 200}
        self.executions: list[str] = []
        self.drain_after_polls: int | None = None
        self._exec_polls = 0
        self.cancel_works = True
        self.scheduler = {"jra-bot-calendar-check": "PAUSED", "jra-bot-reconcile": "PAUSED", "jra-bot-retention": "PAUSED"}
        self.job_exit = {"--mode=validate": 0, "--mode=migrate": 0}
        self.externally_reachable = False
        self.calls: list[str] = []

    def sql_state(self):
        if self.sql["activation_policy"] == "ALWAYS" and self.sql["state"] != "RUNNABLE":
            self._polls += 1
            if self._polls > self.sql_up_after:
                self.sql["state"] = "RUNNABLE"
        return dict(self.sql)

    def sql_set_activation(self, policy):
        self.calls.append(f"sql:{policy}")
        self.sql["activation_policy"] = policy
        if policy == "NEVER":
            self.sql["state"] = "STOPPED"
        else:
            self._polls = 0

    def sql_backup(self):
        self.calls.append("sql:backup")

    def service_state(self, name):
        return dict(self.services[name])

    def service_set_ingress(self, name, ingress):
        self.calls.append(f"ingress:{name}:{ingress}")
        self.services[name]["ingress"] = ingress

    def service_health(self, name, path):
        self.calls.append(f"health:{name}")
        return self.health[name]

    def service_reachable_externally(self, name):
        return self.externally_reachable

    def running_executions(self):
        if self.drain_after_polls is not None:
            self._exec_polls += 1
            if self._exec_polls > self.drain_after_polls:
                self.executions = []
        return list(self.executions)

    def cancel_execution(self, execution):
        self.calls.append(f"cancel:{execution}")
        if self.cancel_works:
            self.executions = [e for e in self.executions if e != execution]

    def run_job(self, job, args):
        self.calls.append(f"job:{job}:{args[0]}")
        return self.job_exit[args[0]]

    def job_set_image(self, job, image):
        self.calls.append(f"job-image:{job}")

    def service_set_image(self, name, image):
        self.calls.append(f"svc-image:{name}")

    def scheduler_states(self):
        return dict(self.scheduler)

    def scheduler_pause(self, name):
        self.calls.append(f"pause:{name}")
        self.scheduler[name] = "PAUSED"

    def scheduler_resume(self, name):
        self.calls.append(f"resume:{name}")
        self.scheduler[name] = "ENABLED"
