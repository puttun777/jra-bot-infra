# Cloud Run の service / job。イメージは release-manifest の digest。release_images / app_runtime が null の間は作らない（基盤だけ先に作る）。
# ingress（受付可否）は ops ワークフローだけが変更する: 作成時は INTERNAL（停止側）で、Terraform は以後変更しない（ignore_changes）。
# IAP の有効化と許可リスト（IAM）は Terraform が管理し、ops は触らない（STOPPED でも認証設定は変えない）。

locals {
  img = local.deploy_enabled ? var.release_images : null

  runtime_env = local.deploy_enabled ? var.app_runtime : {}

  # アプリの共通 DB 設定
  db_env = {
    DB_URL = local.db_url
  }
}

resource "google_cloud_run_v2_service" "dashboard" {
  count = local.deploy_enabled ? 1 : 0

  name                = "${local.prefix}-dashboard"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  iap_enabled         = true
  deletion_protection = true
  launch_stage        = "BETA"

  template {
    service_account                  = google_service_account.sa["dashboard"].email
    timeout                          = "60s"
    max_instance_request_concurrency = 40

    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.main.id
        subnetwork = google_compute_subnetwork.run.id
      }
    }

    containers {
      image = local.img.dashboard
      resources {
        limits = { cpu = "1", memory = "1Gi" }
      }
      dynamic "env" {
        for_each = merge(local.common_env, local.db_env, {
          DB_USER       = "app"
          DB_POOL_MAX   = "3"
          IAP_AUDIENCE  = local.iap_audience
          OPS_SA_EMAIL  = google_service_account.sa["gha-ops"].email
          ALLOWED_USERS = join(",", var.allowed_users)
          ADMIN_USERS   = join(",", var.admin_users)
        })
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = {
          DB_PASSWORD         = "db-app-password"
          INGEST_TOKEN_PEPPER = "ingest-token-pepper"
        }
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secret[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [ingress, client, client_version, template[0].containers[0].image, template[0].revision]
  }

  depends_on = [google_secret_manager_secret_iam_member.access, google_project_service.api]
}

resource "google_cloud_run_v2_service" "ingest" {
  count = local.deploy_enabled ? 1 : 0

  name                = "${local.prefix}-ingest"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  deletion_protection = true

  template {
    service_account                  = google_service_account.sa["ingest"].email
    timeout                          = "60s"
    max_instance_request_concurrency = 20

    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.main.id
        subnetwork = google_compute_subnetwork.run.id
      }
    }

    containers {
      image = local.img.ingest
      resources {
        limits = { cpu = "1", memory = "1Gi" }
      }
      dynamic "env" {
        for_each = merge(local.common_env, local.db_env, {
          DB_USER                    = "ingest"
          DB_POOL_MAX                = "3"
          INTERNAL_ID_TOKEN_AUDIENCE = "https://${local.prefix}-ingest-${var.project_number}.${var.region}.run.app"
          OPS_SA_EMAIL               = google_service_account.sa["gha-ops"].email
          AGENT_HEARTBEAT_PREFIX     = "gs://${local.buckets.ops_state}/agent/"
          INGEST_ODDS_BELOW_PAR      = "quarantine"
          INGEST_STORE_COMBO_ODDS    = "false"
        })
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = {
          DB_PASSWORD         = "db-ingest-password"
          INGEST_TOKEN_PEPPER = "ingest-token-pepper"
          AGENT_KEK_KEYS      = "agent-kek"
        }
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secret[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [ingress, client, client_version, template[0].containers[0].image, template[0].revision]
  }

  depends_on = [google_secret_manager_secret_iam_member.access, google_project_service.api]
}

# 認証されていない呼出しの扱い: ingest はアプリ認証（トークン + HMAC。IAP の外）なので allUsers を invoker にする。ingress=internal の間は到達できない。
resource "google_cloud_run_v2_service_iam_member" "ingest_public_invoker" {
  count = local.deploy_enabled ? 1 : 0

  name     = google_cloud_run_v2_service.ingest[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# dashboard: 直接 IAP。許可リストは本人のメールだけ（空なら誰も入れない）。ops の ID トークンを IAP が通すための ops SA の許可も明示する
resource "google_iap_web_cloud_run_service_iam_member" "dashboard_users" {
  for_each = local.deploy_enabled ? toset(var.allowed_users) : toset([])

  project                = var.project_id
  location               = var.region
  cloud_run_service_name = google_cloud_run_v2_service.dashboard[0].name
  role                   = "roles/iap.httpsResourceAccessor"
  member                 = "user:${each.value}"
}

resource "google_iap_web_cloud_run_service_iam_member" "dashboard_ops_health" {
  count = local.deploy_enabled ? 1 : 0

  project                = var.project_id
  location               = var.region
  cloud_run_service_name = google_cloud_run_v2_service.dashboard[0].name
  role                   = "roles/iap.httpsResourceAccessor"
  member                 = "serviceAccount:${google_service_account.sa["gha-ops"].email}"
}

# ---- Jobs
resource "google_cloud_run_v2_job" "bot" {
  for_each = local.deploy_enabled ? local.bot_jobs : {}

  name                = "${local.prefix}-${each.key}"
  location            = var.region
  deletion_protection = true

  template {
    parallelism = 1
    task_count  = 1
    template {
      service_account = google_service_account.sa["bot"].email
      max_retries     = 0
      timeout         = "${each.value.timeout_seconds}s"

      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          network    = google_compute_network.main.id
          subnetwork = google_compute_subnetwork.run.id
        }
      }

      containers {
        image = local.img.bot
        args  = each.value.args
        resources {
          limits = { cpu = each.value.cpu, memory = each.value.memory }
        }
        dynamic "env" {
          for_each = merge(
            local.common_env,
            local.db_env,
            { DB_USER = "bot", DB_POOL_MAX = each.value.pool_max, MODEL_STORE_URI = "gs://${local.buckets.model_store}" },
            { for k, v in local.runtime_env : k => v if each.value.with_runtime || startswith(k, "CALENDAR_") },
          )
          content {
            name  = env.key
            value = env.value
          }
        }
        env {
          name = "DB_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secret["db-bot-password"].secret_id
              version = "latest"
            }
          }
        }
        dynamic "env" {
          for_each = each.value.with_discord ? {
            DISCORD_WEBHOOK_URL       = "discord-webhook"
            DISCORD_ERROR_WEBHOOK_URL = "discord-error-webhook"
          } : {}
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.secret[env.value].secret_id
                version = "latest"
              }
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [client, client_version, template[0].template[0].containers[0].image]
  }

  depends_on = [google_secret_manager_secret_iam_member.access]
}

resource "google_cloud_run_v2_job" "db_migration" {
  count = local.deploy_enabled ? 1 : 0

  name                = "${local.prefix}-db-migration"
  location            = var.region
  deletion_protection = true

  template {
    template {
      service_account = google_service_account.sa["dbmigration"].email
      max_retries     = 0
      timeout         = "900s"

      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          network    = google_compute_network.main.id
          subnetwork = google_compute_subnetwork.run.id
        }
      }

      containers {
        image = local.img.db_migration
        # --mode は実行時の上書きで必須指定する（info / validate / migrate。既定は無い）
        args = ["--mode=validate"]
        resources {
          limits = { cpu = "1", memory = "1Gi" }
        }
        dynamic "env" {
          for_each = merge(local.common_env, local.db_env, { DB_USER = "migrate", DB_POOL_MAX = "2" })
          content {
            name  = env.key
            value = env.value
          }
        }
        env {
          name = "DB_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secret["db-migrate-password"].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [client, client_version, template[0].template[0].containers[0].image, template[0].template[0].containers[0].args]
  }

  depends_on = [google_secret_manager_secret_iam_member.access]
}

resource "google_cloud_run_v2_job" "ml_train" {
  count = local.deploy_enabled ? 1 : 0

  name                = "${local.prefix}-ml-train"
  location            = var.region
  deletion_protection = true

  template {
    template {
      service_account = google_service_account.sa["mltrain"].email
      max_retries     = 0
      timeout         = "3600s"

      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          network    = google_compute_network.main.id
          subnetwork = google_compute_subnetwork.run.id
        }
      }

      containers {
        image = local.img.ml_train
        # --dataset-id は実行時に指定する（学習は手動 or 週次。Scheduler は初期 paused）
        args = ["--tenant-id=${var.tenant_id}"]
        resources {
          limits = { cpu = "2", memory = "4Gi" }
        }
        dynamic "env" {
          for_each = merge(local.common_env, local.db_env, { DB_USER = "mltrain", DB_POOL_MAX = "1", MODEL_STORE_URI = "gs://${local.buckets.model_store}" })
          content {
            name  = env.key
            value = env.value
          }
        }
        dynamic "env" {
          for_each = { DB_PASSWORD = "db-mltrain-password", MODEL_SIGNING_KEY = "model-signing-key" }
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.secret[env.value].secret_id
                version = "latest"
              }
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [client, client_version, template[0].template[0].containers[0].image, template[0].template[0].containers[0].args]
  }

  depends_on = [google_secret_manager_secret_iam_member.access]
}

# --- Job の実行権限
# Scheduler → calendar-check / reconcile / retention を起動
resource "google_cloud_run_v2_job_iam_member" "scheduler_invoker" {
  for_each = local.deploy_enabled ? local.scheduler_jobs : {}

  name     = google_cloud_run_v2_job.bot[each.value.job].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.sa["scheduler"].email}"
}

# calendar-check（sa-bot）が bot-run を引数つきで起動する（JobLauncher。上書き付きの実行）
resource "google_cloud_run_v2_job_iam_member" "bot_launches_bot_run" {
  count = local.deploy_enabled ? 1 : 0

  name     = google_cloud_run_v2_job.bot["bot-run"].name
  location = var.region
  role     = "roles/run.jobsExecutorWithOverrides"
  member   = "serviceAccount:${google_service_account.sa["bot"].email}"
}

# deploy が db-migration を実行（migrate。NORMAL のときだけ workflow が呼ぶ）。ops は validate のためにカスタムロールで run.jobs.run を持つ
resource "google_cloud_run_v2_job_iam_member" "deploy_runs_migration" {
  count = local.deploy_enabled ? 1 : 0

  name     = google_cloud_run_v2_job.db_migration[0].name
  location = var.region
  role     = "roles/run.jobsExecutorWithOverrides"
  member   = "serviceAccount:${google_service_account.sa["gha-deploy"].email}"
}
