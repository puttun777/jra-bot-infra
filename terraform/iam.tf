# サービスアカウント（長期キーは作らない）。ランタイム SA は用途ごとに分け、触れる Secret・バケットを最小にする（ARCHITECTURE §5 / OPERATIONS_DESIGN §11）。
locals {
  service_accounts = {
    dashboard   = "dashboard の実行"
    ingest      = "ingest の実行"
    bot         = "bot（bot-run・calendar-check・reconcile・retention・export-dataset・backtest）の実行"
    dbmigration = "db-migration の実行"
    mltrain     = "ml-train の実行"
    scheduler   = "Cloud Scheduler が Job を起動する"
    gha-ops     = "start/stop/status（GitHub Actions）"
    gha-deploy  = "deploy（GitHub Actions）"
    gha-tf      = "terraform plan/apply（GitHub Actions）"
  }

  # Secret → アクセスできる SA
  secret_access = {
    "db-app-password"       = ["dashboard"]
    "db-ingest-password"    = ["ingest"]
    "db-bot-password"       = ["bot"]
    "db-migrate-password"   = ["dbmigration"]
    "db-mltrain-password"   = ["mltrain"]
    "discord-webhook"       = ["bot"]
    "discord-error-webhook" = ["bot", "gha-ops"]
    "ingest-token-pepper"   = ["ingest", "dashboard"]
    "agent-kek"             = ["ingest"]
    "beacon-signing-key"    = ["gha-ops"]
    "model-signing-key"     = ["mltrain"]
  }
  secret_access_pairs = merge([
    for secret, sas in local.secret_access : {
      for sa in sas : "${secret}/${sa}" => { secret = secret, sa = sa }
    }
  ]...)

  runtime_sas = ["dashboard", "ingest", "bot", "dbmigration", "mltrain"]
}

resource "google_service_account" "sa" {
  for_each = local.service_accounts

  account_id   = "sa-${each.key}"
  display_name = each.value

  depends_on = [google_project_service.api]
}

# --- Secret Manager（値は Terraform に置かない。本人が `gcloud secrets versions add` で入れる）
resource "google_secret_manager_secret" "secret" {
  for_each = toset(local.secrets)

  secret_id = each.value
  replication {
    auto {}
  }

  depends_on = [google_project_service.api]
}

resource "google_secret_manager_secret_iam_member" "access" {
  for_each = local.secret_access_pairs

  secret_id = google_secret_manager_secret.secret[each.value.secret].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.sa[each.value.sa].email}"
}

# DB パスワードを Terraform（password_wo + ephemeral）が読むための権限は、plan/apply の SA だけ
resource "google_secret_manager_secret_iam_member" "tf_reads_db_passwords" {
  for_each = local.db_users

  secret_id = google_secret_manager_secret.secret[each.value].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.sa["gha-tf"].email}"
}

# --- バケットの権限
resource "google_storage_bucket_iam_member" "ops_state_read" {
  for_each = toset(local.runtime_sas)

  bucket = google_storage_bucket.ops_state.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.sa[each.value].email}"
}

# ingest は agent/ の写し（最終接続時刻だけ）を書く。書込みは agent/ プレフィックスだけ
resource "google_storage_bucket_iam_member" "ops_state_agent_write" {
  bucket = google_storage_bucket.ops_state.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.sa["ingest"].email}"

  condition {
    title       = "agent-prefix-only"
    description = "agent/ 配下のオブジェクトだけ"
    expression  = "resource.name.startsWith(\"projects/_/buckets/${local.buckets.ops_state}/objects/agent/\")"
  }
}

resource "google_storage_bucket_iam_member" "ops_state_ops_admin" {
  bucket = google_storage_bucket.ops_state.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.sa["gha-ops"].email}"
}

resource "google_storage_bucket_iam_member" "beacon_ops_admin" {
  bucket = google_storage_bucket.mode_beacon.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.sa["gha-ops"].email}"
}

resource "google_storage_bucket_iam_member" "model_store_bot_read" {
  bucket = google_storage_bucket.model_store.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.sa["bot"].email}"
}

# bot は datasets/ だけ書く（export-dataset）。models/ には書けない
resource "google_storage_bucket_iam_member" "model_store_bot_datasets" {
  bucket = google_storage_bucket.model_store.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.sa["bot"].email}"

  condition {
    title       = "datasets-prefix-only"
    description = "datasets/ 配下だけ（モデルは書けない）"
    expression  = "resource.name.startsWith(\"projects/_/buckets/${local.buckets.model_store}/objects/datasets/\")"
  }
}

resource "google_storage_bucket_iam_member" "model_store_mltrain" {
  bucket = google_storage_bucket.model_store.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.sa["mltrain"].email}"
}

resource "google_storage_bucket_iam_member" "ops_state_deploy_read" {
  bucket = google_storage_bucket.ops_state.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.sa["gha-deploy"].email}"
}

# deploy は start/stop と同じリース（state/ops-state.json の CAS）を取り、成功したら release を記録する（ops の TS 移行時の修正。web D-256・infra I-031）。
# state/ は上書き（作成 + 削除）が要るので objectUser、history/ は追記だけなので objectCreator（監査記録を消せない）。
# agent/ やバケットの設定・ビーコン・署名鍵には権限を与えない（deploy はビーコンを書かない）
resource "google_storage_bucket_iam_member" "ops_state_deploy_state" {
  bucket = google_storage_bucket.ops_state.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.sa["gha-deploy"].email}"

  condition {
    title       = "state-prefix-only"
    description = "state/ 配下だけ（deploy のリースと release の記録）"
    expression  = "resource.name.startsWith(\"projects/_/buckets/${local.buckets.ops_state}/objects/state/\")"
  }
}

resource "google_storage_bucket_iam_member" "ops_state_deploy_history" {
  bucket = google_storage_bucket.ops_state.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.sa["gha-deploy"].email}"

  condition {
    title       = "history-prefix-only"
    description = "history/ 配下の追記だけ（削除・上書きはできない）"
    expression  = "resource.name.startsWith(\"projects/_/buckets/${local.buckets.ops_state}/objects/history/\")"
  }
}

resource "google_storage_bucket_iam_member" "ops_state_tf_read" {
  bucket = google_storage_bucket.ops_state.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.sa["gha-tf"].email}"
}

# --- Artifact Registry（読取り）
resource "google_artifact_registry_repository_iam_member" "reader" {
  for_each = toset(["dashboard", "ingest", "bot", "dbmigration", "mltrain", "gha-deploy", "gha-ops"])

  repository = google_artifact_registry_repository.images.name
  location   = var.region
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.sa[each.value].email}"
}

# --- 運用（start/stop/status）用のカスタムロール。必要最小限
resource "google_project_iam_custom_role" "ops_controller" {
  role_id     = "jraBotOpsController"
  title       = "JRA Bot ops controller"
  description = "start/stop/status が使う権限だけ。IAM は変更できない。注意: run.services.update は IAP の有効/無効も更新できてしまうため、status が IAP の無効を常に異常として検知する"
  permissions = [
    # Cloud SQL（停止/起動 = activation_policy、バックアップ、状態の読取り）
    "cloudsql.instances.get",
    "cloudsql.instances.list",
    "cloudsql.instances.update",
    "cloudsql.backupRuns.create",
    "cloudsql.backupRuns.get",
    "cloudsql.backupRuns.list",
    # Cloud Run（ingress の更新、Job の実行状況・キャンセル）。Job の実行（引数付き）は db-migration の Job にだけ roles/run.jobsExecutorWithOverrides を付ける（cloud_run.tf）
    "run.services.get",
    "run.services.list",
    "run.services.update",
    "run.jobs.get",
    "run.jobs.list",
    "run.executions.get",
    "run.executions.list",
    "run.executions.cancel",
    "run.operations.get",
    "run.revisions.get",
    "run.revisions.list",
    # Scheduler（pause / resume）
    "cloudscheduler.jobs.get",
    "cloudscheduler.jobs.list",
    "cloudscheduler.jobs.pause",
    "cloudscheduler.jobs.enable",
    # IAP の設定の読取り（status が許可リスト件数を確認する。変更はできない）
    "iap.web.getIamPolicy",
  ]
}

resource "google_project_iam_member" "ops_controller" {
  project = var.project_id
  role    = google_project_iam_custom_role.ops_controller.id
  member  = "serviceAccount:${google_service_account.sa["gha-ops"].email}"
}

# ops が ingress を更新するとき、サービスの実行 SA を actAs できる必要がある（IAM は変更しない）
resource "google_service_account_iam_member" "ops_act_as" {
  for_each = toset(["dashboard", "ingest", "dbmigration"])

  service_account_id = google_service_account.sa[each.value].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.sa["gha-ops"].email}"
}

# ops が自分の ID トークンを作る（ingest /internal/ready の呼出し。G-OPS-7）
resource "google_service_account_iam_member" "ops_id_token" {
  service_account_id = google_service_account.sa["gha-ops"].name
  role               = "roles/iam.serviceAccountOpenIdTokenCreator"
  member             = "serviceAccount:${google_service_account.sa["gha-ops"].email}"
}

# --- deploy 用: イメージ参照の更新と db-migration の実行だけ
resource "google_project_iam_custom_role" "deployer" {
  role_id     = "jraBotDeployer"
  title       = "JRA Bot deployer"
  description = "Cloud Run のイメージ更新と Job 定義の更新。ingress・IAP・IAM は変更しない運用（deploy は ingress を指定しない）"
  permissions = [
    "run.services.get",
    "run.services.list",
    "run.services.update",
    "run.jobs.get",
    "run.jobs.list",
    "run.jobs.update",
    "run.executions.get",
    "run.executions.list",
    "run.operations.get",
    "run.revisions.get",
    "run.revisions.list",
  ]
}

resource "google_project_iam_member" "deployer" {
  project = var.project_id
  role    = google_project_iam_custom_role.deployer.id
  member  = "serviceAccount:${google_service_account.sa["gha-deploy"].email}"
}

resource "google_service_account_iam_member" "deploy_act_as" {
  for_each = toset(local.runtime_sas)

  service_account_id = google_service_account.sa[each.value].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.sa["gha-deploy"].email}"
}

# --- Terraform 用。構成管理に必要な広い権限（第5段階の実機検証で最小化する: 未検証）
resource "google_project_iam_member" "tf" {
  for_each = toset([
    "roles/run.admin",
    "roles/cloudsql.admin",
    "roles/compute.networkAdmin",
    "roles/servicenetworking.networksAdmin",
    "roles/iam.serviceAccountAdmin",
    "roles/iam.workloadIdentityPoolAdmin",
    "roles/iam.roleAdmin",
    "roles/secretmanager.admin",
    "roles/storage.admin",
    "roles/artifactregistry.admin",
    "roles/cloudscheduler.admin",
    "roles/monitoring.admin",
    "roles/serviceusage.serviceUsageAdmin",
    "roles/resourcemanager.projectIamAdmin",
    "roles/iap.admin",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.sa["gha-tf"].email}"
}

# terraform が Cloud Run / Scheduler / Job を作るとき、実行 SA を actAs できる必要がある
resource "google_service_account_iam_member" "tf_act_as" {
  for_each = local.service_accounts

  service_account_id = google_service_account.sa[each.key].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.sa["gha-tf"].email}"
}

# --- GitHub Actions → GCP（WIF。長期キー無し）
resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "${local.prefix}-github"
  display_name              = "GitHub Actions"

  depends_on = [google_project_service.api]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.repository"       = "assertion.repository"
    "attribute.ref"              = "assertion.ref"
    "attribute.workflow_ref"     = "assertion.workflow_ref"
    "attribute.job_workflow_ref" = "assertion.job_workflow_ref"
    "attribute.environment"      = "assertion.environment"
  }

  # この infra リポジトリ以外（web を含む）は拒否。web からの Artifact Registry push は本人確認の上で別途付与する（推測しない）
  attribute_condition = "assertion.repository == \"${var.github_repo_infra}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

locals {
  wif_principal_base = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}"

  # 許可するワークフロー（main ブランチの対象ファイルだけ。tf は GitHub Environment `terraform` の承認を通ったジョブだけ）
  wif_ref = "refs/heads/main"
  wif_workflows = {
    "ops-start"  = { sa = "gha-ops", file = "ops-start.yml" }
    "ops-stop"   = { sa = "gha-ops", file = "ops-stop.yml" }
    "ops-status" = { sa = "gha-ops", file = "ops-status.yml" }
    "deploy"     = { sa = "gha-deploy", file = "deploy.yml" }
    # terraform は main の対象ワークフローだけ（Environment の保護に加えて、コード側でも ref とワークフローを束縛する）
    "terraform-plan"  = { sa = "gha-tf", file = "terraform-plan.yml" }
    "terraform-apply" = { sa = "gha-tf", file = "terraform-apply.yml" }
  }
  wif_bindings = {
    for k, w in local.wif_workflows : k => {
      sa     = w.sa
      member = "${local.wif_principal_base}/attribute.workflow_ref/${var.github_repo_infra}/.github/workflows/${w.file}@${local.wif_ref}"
    }
  }
}

resource "google_service_account_iam_member" "wif" {
  for_each = local.wif_bindings

  service_account_id = google_service_account.sa[each.value.sa].name
  role               = "roles/iam.workloadIdentityUser"
  member             = each.value.member
}
