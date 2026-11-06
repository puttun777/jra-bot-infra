terraform {
  required_version = ">= 1.17.1, < 2.0.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "8.10.0"
    }
  }

  # state は GCS（バケットは bootstrap で作成。名前は -backend-config で渡す。validate / test は -backend=false）。
  # state に秘密を載せない設計: DB パスワードは write-only 引数（password_wo）+ ephemeral の Secret Manager 参照。
  backend "gcs" {
    prefix = "jra-bot/main"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
