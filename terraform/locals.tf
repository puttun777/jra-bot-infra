locals {
  prefix = "jra-bot"

  # 有効化する API
  apis = [
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudscheduler.googleapis.com",
    "compute.googleapis.com",
    "servicenetworking.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "iap.googleapis.com",
    "monitoring.googleapis.com",
    "logging.googleapis.com",
    "billingbudgets.googleapis.com",
  ]

  # バケット名（グローバルに一意。プロジェクト ID を接頭辞にする）
  buckets = {
    ops_state   = "${var.project_id}-ops-state"
    mode_beacon = "${var.project_id}-mode-beacon"
    model_store = "${var.project_id}-model-store"
  }

  # Secret の名前（値は Terraform に置かない。本人が gcloud で追加する）。CONTRACTS §2 / infra CONTRACTS §5
  secrets = [
    "db-app-password",
    "db-ingest-password",
    "db-bot-password",
    "db-migrate-password",
    "db-mltrain-password",
    "discord-webhook",
    "discord-error-webhook",
    "ingest-token-pepper",
    "agent-kek",
    "beacon-signing-key",
    "model-signing-key",
  ]

  # DB ユーザー（web CONTRACTS §8.2）と、そのパスワードの Secret
  db_users = {
    migrate = "db-migrate-password"
    app     = "db-app-password"
    ingest  = "db-ingest-password"
    bot     = "db-bot-password"
    mltrain = "db-mltrain-password"
  }

  deploy_enabled = var.release_images != null && var.app_runtime != null

  # --- 共通の環境変数（全アプリ）
  common_env = {
    APP_ENV         = "prod"
    TZ              = "Asia/Tokyo"
    OPS_MODE_SOURCE = "gs://${local.buckets.ops_state}/state/ops-state.json"
  }

  db_url = "jdbc:mysql://${google_sql_database_instance.main.private_ip_address}:3306/jrabot?sslMode=VERIFY_CA"

  iap_audience = "/projects/${var.project_number}/locations/${var.region}/services/${local.prefix}-dashboard"

  # bot の Job 一覧（タスク名 → 実行設定）。bot イメージ 1 つを --task で切り替える（web CONTRACTS §1）
  bot_jobs = {
    "bot-run" = {
      args            = ["--task=bot-run", "--tenant-id=${var.tenant_id}"]
      cpu             = "1"
      memory          = "2Gi"
      timeout_seconds = 50400 # 14 時間（G-OPS-5 で上限を実機確認）
      pool_max        = "4"
      with_runtime    = true
      with_discord    = true
    }
    "calendar-check" = {
      args            = ["--task=calendar-check", "--tenant-id=${var.tenant_id}"]
      cpu             = "0.5"
      memory          = "1Gi"
      timeout_seconds = 300
      pool_max        = "1"
      with_runtime    = false
      with_discord    = false
    }
    "reconcile" = {
      args            = ["--task=reconcile", "--tenant-id=${var.tenant_id}"]
      cpu             = "0.5"
      memory          = "1Gi"
      timeout_seconds = 900
      pool_max        = "1"
      with_runtime    = false
      with_discord    = false
    }
    "retention" = {
      args            = ["--task=retention", "--tenant-id=${var.tenant_id}"]
      cpu             = "0.5"
      memory          = "1Gi"
      timeout_seconds = 900
      pool_max        = "1"
      with_runtime    = false
      with_discord    = false
    }
    "export-dataset" = {
      args            = ["--task=export-dataset", "--tenant-id=${var.tenant_id}"]
      cpu             = "1"
      memory          = "2Gi"
      timeout_seconds = 3600
      pool_max        = "2"
      with_runtime    = false
      with_discord    = false
    }
    # バックテスト（web D-265・CONTRACTS 0.4.18）。bot-run と同じ BOT_RUN_*・ML の設定、Discord なし、DB は読取りだけ。本人が手動で実行する
    "backtest" = {
      args            = ["--task=backtest", "--tenant-id=${var.tenant_id}"]
      cpu             = "1"
      memory          = "2Gi"
      timeout_seconds = 3600
      pool_max        = "1"
      with_runtime    = true
      with_discord    = false
    }
  }

  # Scheduler（JST）。calendar-check は開催日の朝〜夕に 15 分ごと、reconcile は夜に、retention は月 1 回
  scheduler_jobs = {
    "calendar-check" = { schedule = "*/15 6-18 * * *", job = "calendar-check" }
    "reconcile"      = { schedule = "30 21 * * *", job = "reconcile" }
    "retention"      = { schedule = "0 4 1 * *", job = "retention" }
  }
}
