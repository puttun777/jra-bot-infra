# 基盤だけ（release_images / app_runtime = null）。モック プロバイダで plan する = 実 GCP の plan ではない（GCP の認証・状態を使わない構成の検査）。
mock_provider "google" {}

variables {
  project_id     = "jra-bot-test-1"
  project_number = "123456789012"
}

run "base_has_no_cloud_run_and_no_scheduler" {
  command = plan

  assert {
    condition     = length(google_cloud_run_v2_service.dashboard) == 0 && length(google_cloud_run_v2_service.ingest) == 0
    error_message = "images が無い間は service を作らない"
  }
  assert {
    condition     = length(google_cloud_run_v2_job.bot) == 0 && length(google_cloud_scheduler_job.job) == 0
    error_message = "images が無い間は job と Scheduler を作らない"
  }
}

run "buckets_are_private_except_the_beacon" {
  command = plan

  assert {
    condition     = google_storage_bucket.ops_state.public_access_prevention == "enforced" && google_storage_bucket.model_store.public_access_prevention == "enforced"
    error_message = "ops-state と model-store は公開を禁止する"
  }
  assert {
    condition     = google_storage_bucket.ops_state.versioning[0].enabled && google_storage_bucket.model_store.versioning[0].enabled
    error_message = "ops-state と model-store はバージョニング"
  }
  assert {
    condition     = google_storage_bucket_iam_member.beacon_public_read.member == "allUsers" && google_storage_bucket_iam_member.beacon_public_read.bucket == google_storage_bucket.mode_beacon.name
    error_message = "公開読取りはビーコンのバケットだけ"
  }
}

run "database_is_private_and_not_controlled_by_terraform" {
  command = plan

  assert {
    condition     = google_sql_database_instance.main.settings[0].ip_configuration[0].ipv4_enabled == false
    error_message = "Cloud SQL に公開 IP を付けない"
  }
  assert {
    condition     = google_sql_database_instance.main.settings[0].edition == "ENTERPRISE" && google_sql_database_instance.main.settings[0].tier == "db-g1-small"
    error_message = "Enterprise + db-g1-small"
  }
  assert {
    condition     = google_sql_database_instance.main.deletion_protection == true && google_sql_database_instance.main.settings[0].deletion_protection_enabled == true
    error_message = "削除保護"
  }
  assert {
    condition     = google_sql_database_instance.main.settings[0].ip_configuration[0].ssl_mode == "ENCRYPTED_ONLY"
    error_message = "TLS 必須"
  }
}

run "db_users_use_write_only_passwords" {
  command = plan

  assert {
    condition     = alltrue([for k, u in google_sql_user.db : u.password == null])
    error_message = "パスワードを state に残す引数（password）を使わない（password_wo を使う）"
  }
  assert {
    condition     = toset(keys(google_sql_user.db)) == toset(["migrate", "app", "ingest", "bot", "mltrain"])
    error_message = "DB ユーザーは 5 つ（web CONTRACTS §8.2）"
  }
}

run "github_federation_is_restricted_to_the_infra_repository" {
  command = plan

  assert {
    condition     = google_iam_workload_identity_pool_provider.github.attribute_condition == "assertion.repository == \"puttun777/jra-bot-infra\""
    error_message = "WIF はこのリポジトリだけ"
  }
  assert {
    condition     = alltrue([for k, b in google_service_account_iam_member.wif : b.role == "roles/iam.workloadIdentityUser"])
    error_message = "WIF の束縛は workloadIdentityUser だけ"
  }
  assert {
    condition = { for k, v in local.wif_bindings : k => v.sa } == {
      "ops-start"  = "gha-ops"
      "ops-stop"   = "gha-ops"
      "ops-status" = "gha-ops"
      "deploy"     = "gha-deploy"
      "terraform"  = "gha-tf"
    }
    error_message = "WIF で借りられる SA は、対応するワークフローごとに 1 つだけ"
  }
}

run "no_primitive_owner_or_editor_roles" {
  command = plan

  assert {
    condition     = alltrue([for r, v in google_project_iam_member.tf : !contains(["roles/owner", "roles/editor"], r)])
    error_message = "owner / editor を付けない"
  }
}

run "ops_role_cannot_change_iam_or_iap" {
  command = plan

  assert {
    condition     = !anytrue([for p in google_project_iam_custom_role.ops_controller.permissions : can(regex("setIamPolicy|iap\\.web\\.setIamPolicy|iam\\.serviceAccounts\\.(create|delete)", p))])
    error_message = "ops ロールは IAM / IAP の変更権限を持たない"
  }
  assert {
    condition     = contains(google_project_iam_custom_role.ops_controller.permissions, "cloudsql.instances.update") && contains(google_project_iam_custom_role.ops_controller.permissions, "cloudscheduler.jobs.pause")
    error_message = "start/stop に必要な権限はある"
  }
}

run "secrets_have_no_versions_in_terraform" {
  command = plan

  assert {
    condition     = length(google_secret_manager_secret.secret) == 11
    error_message = "Secret は 11 個（infra CONTRACTS §4 / web CONTRACTS §2）"
  }
}
