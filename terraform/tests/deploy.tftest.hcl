mock_provider "google" {}

variables {
  project_id     = "jra-bot-test-1"
  project_number = "123456789012"
  allowed_users  = ["me@example.com"]
  admin_users    = ["me@example.com"]
  release_images = {
    dashboard    = "asia-northeast1-docker.pkg.dev/jra-bot-test-1/jra-bot/dashboard@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ingest       = "asia-northeast1-docker.pkg.dev/jra-bot-test-1/jra-bot/ingest@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    bot          = "asia-northeast1-docker.pkg.dev/jra-bot-test-1/jra-bot/bot@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    db_migration = "asia-northeast1-docker.pkg.dev/jra-bot-test-1/jra-bot/db-migration@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    ml_train     = "asia-northeast1-docker.pkg.dev/jra-bot-test-1/jra-bot/ml-train@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  }
  # テスト用の合成値（運用値ではない）
  app_runtime = {
    CALENDAR_WATCH_START_MINUTES     = "120"
    CALENDAR_PRESTART_MINUTES        = "10"
    CALENDAR_SETTLE_DEADLINE_MINUTES = "90"
    CALENDAR_STALE_AFTER_MINUTES     = "120"
    BOT_RUN_LEASE_SECONDS            = "300"
    BOT_RUN_HEARTBEAT_SECONDS        = "60"
    BOT_RUN_POLL_FAR_SECONDS         = "300"
    BOT_RUN_POLL_MID_SECONDS         = "60"
    BOT_RUN_POLL_NEAR_SECONDS        = "30"
    BOT_RUN_MAX_ODDS_AGE_SECONDS     = "180"
    BOT_RUN_MAX_RUNTIME_MINUTES      = "840"
    BOT_RUN_STALE_CLAIM_SECONDS      = "900"
    BOT_RUN_MAX_CYCLE_FAILURES       = "3"
    BOT_RUN_SNAPSHOT_MINUTES         = "30,5"
    BOT_RUN_TIGHTEN_NEAR             = "false"
    BOT_RUN_SNAPSHOT_HISTORY_LIMIT   = "3"
    BOT_RUN_RESULT_AFTER_MINUTES     = "30"
    BOT_RUN_RESULT_POLL_SECONDS      = "300"
    BOT_RUN_ML_MODEL_TYPE            = "off"
    BOT_RUN_DECISION_PROFILE         = "legacy_function_defaults"
  }
}

run "services_start_closed_with_iap_and_pinned_digests" {
  command = plan

  assert {
    condition     = google_cloud_run_v2_service.dashboard[0].ingress == "INGRESS_TRAFFIC_INTERNAL_ONLY" && google_cloud_run_v2_service.ingest[0].ingress == "INGRESS_TRAFFIC_INTERNAL_ONLY"
    error_message = "作成時の ingress は internal（停止側）。開けるのは ops-start だけ"
  }
  assert {
    condition     = google_cloud_run_v2_service.dashboard[0].iap_enabled == true
    error_message = "dashboard は直接 IAP"
  }
  assert {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", google_cloud_run_v2_service.dashboard[0].template[0].containers[0].image))
    error_message = "digest 固定"
  }
}

run "iap_allow_list_is_only_the_owner_plus_ops_health" {
  command = plan

  assert {
    condition     = toset(keys(google_iap_web_cloud_run_service_iam_member.dashboard_users)) == toset(["me@example.com"])
    error_message = "許可は allowed_users だけ"
  }
}

run "jobs_never_retry_and_bot_run_has_14h_timeout" {
  command = plan

  assert {
    condition     = alltrue([for k, j in google_cloud_run_v2_job.bot : j.template[0].template[0].max_retries == 0])
    error_message = "Job は自動再試行しない（max-retries=0。web CONTRACTS §9.1）"
  }
  assert {
    condition     = google_cloud_run_v2_job.bot["bot-run"].template[0].template[0].timeout == "50400s"
    error_message = "bot-run は 14 時間"
  }
  assert {
    condition     = toset(keys(google_cloud_run_v2_job.bot)) == toset(["bot-run", "calendar-check", "reconcile", "retention", "export-dataset"])
    error_message = "bot の Job は 5 種類（bot イメージ + --task）"
  }
}

run "scheduler_is_created_paused" {
  command = plan

  assert {
    condition     = alltrue([for k, j in google_cloud_scheduler_job.job : j.paused == true])
    error_message = "Scheduler は PAUSED で作る（start が resume）"
  }
  assert {
    condition     = alltrue([for k, j in google_cloud_scheduler_job.job : j.time_zone == "Asia/Tokyo" && j.retry_config[0].retry_count == 0])
    error_message = "JST・再試行なし"
  }
}

run "bot_run_receives_the_result_wait_settings_and_discord_secrets" {
  command = plan

  assert {
    condition     = anytrue([for e in google_cloud_run_v2_job.bot["bot-run"].template[0].template[0].containers[0].env : e.name == "BOT_RUN_RESULT_AFTER_MINUTES"])
    error_message = "結果待ちの設定が bot-run に渡る"
  }
  assert {
    condition     = anytrue([for e in google_cloud_run_v2_job.bot["bot-run"].template[0].template[0].containers[0].env : e.name == "DISCORD_WEBHOOK_URL"])
    error_message = "Discord の Webhook は Secret から"
  }
  assert {
    condition     = !anytrue([for e in google_cloud_run_v2_job.bot["calendar-check"].template[0].template[0].containers[0].env : e.name == "DISCORD_WEBHOOK_URL"])
    error_message = "calendar-check に Discord の Secret を渡さない"
  }
}

run "tags_are_rejected" {
  command = plan
  variables {
    release_images = {
      dashboard    = "asia-northeast1-docker.pkg.dev/jra-bot-test-1/jra-bot/dashboard:latest"
      ingest       = "x"
      bot          = "x"
      db_migration = "x"
      ml_train     = "x"
    }
  }
  expect_failures = [var.release_images]
}

run "admin_must_be_allowed" {
  command = plan
  variables {
    admin_users = ["stranger@example.com"]
  }
  expect_failures = [var.admin_users]
}

run "missing_operational_values_are_rejected" {
  command = plan
  variables {
    app_runtime = { BOT_RUN_LEASE_SECONDS = "300" }
  }
  expect_failures = [var.app_runtime]
}
