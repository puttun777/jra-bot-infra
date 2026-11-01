# 運用モードの正本（非公開・バージョニング）。書くのは ops ワークフロー（sa-gha-ops）だけ。アプリは読取り（agent/ の写しは ingest が書く）。
resource "google_storage_bucket" "ops_state" {
  name                        = local.buckets.ops_state
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }
  lifecycle_rule {
    condition {
      num_newer_versions = 50
      with_state         = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.api]
}

# モードビーコン（署名付き・秘密なし）。このバケットには beacon/mode.json だけを置く。公開読取りはこのバケットだけ。
resource "google_storage_bucket" "mode_beacon" {
  name                        = local.buckets.mode_beacon
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "inherited"
  force_destroy               = false

  depends_on = [google_project_service.api]
}

resource "google_storage_bucket_iam_member" "beacon_public_read" {
  bucket = google_storage_bucket.mode_beacon.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

# モデルとデータセット（非公開）。データセットは 90 日で削除。
resource "google_storage_bucket" "model_store" {
  name                        = local.buckets.model_store
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }
  lifecycle_rule {
    condition {
      age            = 90
      matches_prefix = ["datasets/"]
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.api]
}
