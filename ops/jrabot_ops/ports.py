from __future__ import annotations

from typing import Protocol


class ConflictError(Exception):
    """GCS の条件付き書込（ifGenerationMatch）が競合した（他の書込みが先に入った）。"""


class StateStore(Protocol):
    def read(self) -> tuple[dict | None, int]:
        """(状態, generation)。オブジェクトが無ければ (None, 0)。"""

    def write(self, state: dict, if_generation: int) -> int:
        """ifGenerationMatch=if_generation で書く。競合なら ConflictError。新しい generation を返す。"""

    def append_history(self, name: str, state: dict) -> None:
        """history/ に追記（同じ名前の上書きはしない）。"""


class BeaconStore(Protocol):
    def write(self, raw: bytes) -> None:
        """beacon/mode.json を書く（Cache-Control: no-store, application/json）。"""


class Gcp(Protocol):
    # Cloud SQL
    def sql_state(self) -> dict:
        """{'state': 'RUNNABLE'|'STOPPED'|..., 'activation_policy': 'ALWAYS'|'NEVER', 'edition': ..., 'version': ...}"""

    def sql_set_activation(self, policy: str) -> None: ...

    def sql_backup(self) -> None: ...

    # Cloud Run service
    def service_state(self, name: str) -> dict:
        """{'ingress': 'internal'|'all'|..., 'ready': bool, 'iap_enabled': bool, 'iap_members': int, 'url': str}"""

    def service_set_ingress(self, name: str, ingress: str) -> None: ...

    def service_health(self, name: str, path: str) -> int:
        """ID トークンを付けて GET し、HTTP ステータスを返す（到達できなければ 0）。"""

    def service_reachable_externally(self, name: str) -> bool:
        """外部（認証なし）から到達できるか。STOPPED 検証用。"""

    # Cloud Run Jobs
    def running_executions(self) -> list[str]: ...

    def cancel_execution(self, execution: str) -> None: ...

    def run_job(self, job: str, args: list[str]) -> int:
        """Job を実行し、終了コードを返す（完了まで待つ）。"""

    def job_image(self, job: str) -> str | None: ...

    def job_set_image(self, job: str, image: str) -> None: ...

    def service_set_image(self, name: str, image: str) -> None: ...

    # Scheduler
    def scheduler_states(self) -> dict[str, str]:
        """{'jra-bot-calendar-check': 'ENABLED'|'PAUSED'}"""

    def scheduler_pause(self, name: str) -> None: ...

    def scheduler_resume(self, name: str) -> None: ...


class Clock(Protocol):
    def now(self) -> str:
        """UTC ISO 8601（秒、Z）。"""

    def sleep(self, seconds: float) -> None: ...
