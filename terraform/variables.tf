variable "project_id" {
  description = "GCP プロジェクト ID（課金リソースを作るプロジェクト。本人が作成する）"
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id の形式が不正です。"
  }
}

variable "project_number" {
  description = "プロジェクト番号（IAP の audience・WIF の principal に使う）"
  type        = string
  validation {
    condition     = can(regex("^[0-9]{6,15}$", var.project_number))
    error_message = "project_number は数字だけです。"
  }
}

variable "region" {
  type    = string
  default = "asia-northeast1"
}

variable "github_repo_infra" {
  description = "infra リポジトリ（WIF の条件）"
  type        = string
  default     = "puttun777/jra-bot-infra"
}

variable "github_repo_web" {
  description = "web リポジトリ（Artifact Registry への push 権限は本人確認後に別途付与。ここでは使わない）"
  type        = string
  default     = "puttun777/jra-bot-web"
}

variable "allowed_users" {
  description = "dashboard にアクセスできる本人のメール（IAP の許可）。空なら誰も入れない（deny by default）。アプリの ALLOWED_USERS にも同じ値を渡す"
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for u in var.allowed_users : can(regex("^[^@\\s]+@[^@\\s]+$", u))])
    error_message = "allowed_users はメールアドレスの一覧です。"
  }
}

variable "admin_users" {
  description = "ADMIN ロールを許す本人のメール（アプリの ADMIN_USERS）。allowed_users の部分集合"
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for u in var.admin_users : contains(var.allowed_users, u)])
    error_message = "admin_users は allowed_users に含まれていなければなりません。"
  }
}

variable "tenant_id" {
  description = "本人のテナント ID（Job の引数 --tenant-id）"
  type        = number
  default     = 1
}

variable "db_tier" {
  type    = string
  default = "db-g1-small"
}

variable "db_version" {
  description = "Cloud SQL の MySQL 版。8.4 LTS を基準（9.7 は互換検証後に再判断: infra I-013）"
  type        = string
  default     = "MYSQL_8_4"
}

variable "db_disk_size_gb" {
  type    = number
  default = 20
}

variable "db_disk_autoresize_limit_gb" {
  type    = number
  default = 50
}

variable "maintenance_window" {
  description = "Cloud SQL のメンテナンス枠（開催日の監視時間帯を避ける）。day: 1=月..7=日、hour: UTC"
  type = object({
    day  = number
    hour = number
  })
  default = { day = 2, hour = 18 }
}

variable "release_images" {
  description = "release-manifest.json の images（digest 固定）。null の間は Cloud Run の service/job を作らない（基盤だけを先に作る）。タグは不可"
  type = object({
    dashboard    = string
    ingest       = string
    bot          = string
    db_migration = string
    ml_train     = string
  })
  default = null
  validation {
    condition = var.release_images == null ? true : alltrue([
      for v in values(var.release_images) :
      can(regex("^[a-z0-9-]+-docker\\.pkg\\.dev/[a-z0-9.:-]+/[a-z0-9._-]+/[a-z0-9._-]+@sha256:[0-9a-f]{64}$", v))
    ])
    error_message = "release_images はすべて <registry>/<project>/<repo>/<name>@sha256:<64桁> の digest 参照にしてください（タグ不可）。"
  }
}

variable "app_runtime" {
  description = <<-EOT
    アプリの運用値（CONTRACTS §2。CALENDAR_* / BOT_RUN_*）。**既定値は無い**（運用値は本人の確認 T1.20 後に確定する）。release_images を指定するときは必須。
    値は文字列のまま環境変数に渡す。
  EOT
  type        = map(string)
  default     = null
  validation {
    condition = var.app_runtime == null ? true : alltrue([
      for k in [
        "CALENDAR_WATCH_START_MINUTES", "CALENDAR_PRESTART_MINUTES", "CALENDAR_SETTLE_DEADLINE_MINUTES", "CALENDAR_STALE_AFTER_MINUTES",
        "BOT_RUN_LEASE_SECONDS", "BOT_RUN_HEARTBEAT_SECONDS", "BOT_RUN_POLL_FAR_SECONDS", "BOT_RUN_POLL_MID_SECONDS", "BOT_RUN_POLL_NEAR_SECONDS",
        "BOT_RUN_MAX_ODDS_AGE_SECONDS", "BOT_RUN_MAX_RUNTIME_MINUTES", "BOT_RUN_STALE_CLAIM_SECONDS", "BOT_RUN_MAX_CYCLE_FAILURES",
        "BOT_RUN_SNAPSHOT_MINUTES", "BOT_RUN_TIGHTEN_NEAR", "BOT_RUN_SNAPSHOT_HISTORY_LIMIT", "BOT_RUN_RESULT_AFTER_MINUTES",
        "BOT_RUN_RESULT_POLL_SECONDS", "BOT_RUN_ML_MODEL_TYPE", "BOT_RUN_DECISION_PROFILE",
      ] : contains(keys(var.app_runtime), k)
    ])
    error_message = "app_runtime に必須の運用値（CALENDAR_* / BOT_RUN_*）が足りません。"
  }
}

variable "alert_email" {
  description = "監視アラートの通知先メール（空なら通知チャネルを作らない）"
  type        = string
  default     = ""
}

variable "billing_account_id" {
  description = "予算アラートを作る請求アカウント ID（空なら作らない。請求の権限が必要なので本人が設定）"
  type        = string
  default     = ""
}

variable "monthly_budget_jpy" {
  type    = number
  default = 12000
}

variable "scheduler_resume_on_create" {
  description = "false（既定）: Scheduler は PAUSED で作る。start ワークフローが resume する（意図しない起動を防ぐ）"
  type        = bool
  default     = false
}
