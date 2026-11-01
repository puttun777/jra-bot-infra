# 秘密を含まない値だけ（ワークフローが参照する）。
output "project_id" {
  value = var.project_id
}

output "region" {
  value = var.region
}

output "artifact_registry" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "buckets" {
  value = local.buckets
}

output "cloud_sql_instance" {
  value = google_sql_database_instance.main.name
}

output "service_accounts" {
  value = { for k, v in google_service_account.sa : k => v.email }
}

output "wif_provider" {
  description = "GitHub Actions の auth に渡す workload_identity_provider"
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "services" {
  value = {
    dashboard = local.deploy_enabled ? google_cloud_run_v2_service.dashboard[0].name : null
    ingest    = local.deploy_enabled ? google_cloud_run_v2_service.ingest[0].name : null
  }
}

output "jobs" {
  value = local.deploy_enabled ? merge(
    { for k, v in google_cloud_run_v2_job.bot : k => v.name },
    { "db-migration" = google_cloud_run_v2_job.db_migration[0].name, "ml-train" = google_cloud_run_v2_job.ml_train[0].name },
  ) : {}
}

output "scheduler_jobs" {
  value = local.deploy_enabled ? [for k, v in google_cloud_scheduler_job.job : v.name] : []
}

output "iap_audience" {
  value = local.iap_audience
}
