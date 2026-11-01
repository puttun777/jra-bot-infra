# Cloud SQL for MySQL（Enterprise・db-g1-small・プライベート IP のみ・公開 IP なし）。
# 起動/停止（activation_policy）は ops ワークフローだけが変更する。**作成時は ALWAYS**: データベース・ユーザーの作成（Terraform）は起動中でないと失敗するため。
# 初回の apply の直後は DB が起動中（課金中）なので、**続けて ops-stop を実行する**（OPERATIONS.md の初期導入）。以後 Terraform はこの値を変更しない（ignore_changes）。
# 停止中（STOPPED）は DB・ユーザーの読取り（refresh）が失敗し得るので、plan/apply は mode=NORMAL のときだけ実行する（apply 前ガード: OPERATIONS_DESIGN §8.2）。
resource "google_sql_database_instance" "main" {
  name                = "${local.prefix}-db"
  region              = var.region
  database_version    = var.db_version
  deletion_protection = true

  settings {
    tier                        = var.db_tier
    edition                     = "ENTERPRISE"
    availability_type           = "ZONAL"
    activation_policy           = "ALWAYS"
    disk_type                   = "PD_SSD"
    disk_size                   = var.db_disk_size_gb
    disk_autoresize             = true
    disk_autoresize_limit       = var.db_disk_autoresize_limit_gb
    deletion_protection_enabled = true

    ip_configuration {
      ipv4_enabled                                  = false
      private_network                               = google_compute_network.main.id
      ssl_mode                                      = "ENCRYPTED_ONLY"
      enable_private_path_for_google_cloud_services = false
    }

    backup_configuration {
      enabled                        = true
      start_time                     = "18:00" # UTC = 03:00 JST
      point_in_time_recovery_enabled = false   # データ損失の許容は最大 1 日（取込は再取得可能）。必要になれば有効化
      transaction_log_retention_days = 1
      backup_retention_settings {
        retained_backups = 7
        retention_unit   = "COUNT"
      }
    }

    maintenance_window {
      day          = var.maintenance_window.day
      hour         = var.maintenance_window.hour
      update_track = "stable"
    }

    database_flags {
      name  = "character_set_server"
      value = "utf8mb4"
    }
    database_flags {
      name  = "time_zone"
      value = "+00:00"
    }
  }

  lifecycle {
    # start/stop が変更する。Terraform の apply が DB の起動状態を変えないようにする（OPERATIONS_DESIGN §8）
    ignore_changes = [settings[0].activation_policy]
  }

  depends_on = [google_service_networking_connection.private_services, google_project_service.api]
}

resource "google_sql_database" "jrabot" {
  name      = "jrabot"
  instance  = google_sql_database_instance.main.name
  charset   = "utf8mb4"
  collation = "utf8mb4_0900_ai_ci"
}

# DB ユーザー。パスワードは Secret Manager の最新版を ephemeral で読み、write-only 引数で渡す（state に残らない）。
# Secret に版が無い間（初回）は plan が失敗する = 先に本人が値を入れる（OPERATIONS.md の初期導入）。GRANT は web の Flyway（R__grants.sql）。
ephemeral "google_secret_manager_secret_version" "db_password" {
  for_each = local.db_users

  secret  = google_secret_manager_secret.secret[each.value].secret_id
  version = "latest"
}

resource "google_sql_user" "db" {
  for_each = local.db_users

  instance            = google_sql_database_instance.main.name
  name                = each.key
  host                = "%"
  password_wo         = ephemeral.google_secret_manager_secret_version.db_password[each.key].secret_data
  password_wo_version = 1
}
