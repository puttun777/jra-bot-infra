resource "google_artifact_registry_repository" "images" {
  repository_id = local.prefix
  location      = var.region
  format        = "DOCKER"
  description   = "JRA Bot のコンテナイメージ（digest 固定でデプロイ）"

  # 各イメージの最新 3 版を残す。稼働中の digest は deploy ワークフローが参照しているため、削除される前に再デプロイが必要（OPERATIONS.md）
  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 3
    }
  }
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "2592000s"
    }
  }

  depends_on = [google_project_service.api]
}
