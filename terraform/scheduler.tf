# Cloud Scheduler → Cloud Run Jobs の run API。**作成時は PAUSED**（start ワークフローが resume する。意図しない起動を防ぐ）。
# paused は ops が変更する値なので Terraform は以後変更しない（ignore_changes）。
resource "google_cloud_scheduler_job" "job" {
  for_each = local.deploy_enabled ? local.scheduler_jobs : {}

  name             = "${local.prefix}-${each.key}"
  region           = var.region
  schedule         = each.value.schedule
  time_zone        = "Asia/Tokyo"
  paused           = !var.scheduler_resume_on_create
  attempt_deadline = "180s"

  retry_config {
    retry_count = 0 # Jobs 側でも再試行しない（max-retries=0）。次の定時に任せる
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.bot[each.value.job].name}:run"
    body        = base64encode("{}")
    headers     = { "Content-Type" = "application/json" }
    oauth_token {
      service_account_email = google_service_account.sa["scheduler"].email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  lifecycle {
    ignore_changes = [paused]
  }

  depends_on = [google_project_service.api]
}

# ml-train は手動（または週次）。Scheduler は作らない（引数 --dataset-id が必要。OPERATIONS.md の手順で workflow_dispatch から実行）
