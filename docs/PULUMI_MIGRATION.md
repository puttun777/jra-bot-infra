# Terraform → Pulumi（TypeScript）移行（L6。web D-250・D-252、infra I-036〜）

**この文書の範囲**: 定義（コード）・試験・preview の準備まで。**`pulumi up` / `destroy` / `import`・state の移行・課金リソースの作成は本人の承認後**（CLAUDE.md・web CLAUDE.md の委任の対象外）。本セッションには GCP の認証が無いので、**実リソース・Terraform の state の有無は未確認**（推測しない）。

## 1. 方針
- 正本は当面 Terraform（`terraform/`）のまま。Pulumi（`pulumi/`）は**同じ構成を表す定義**として追加し、mock を使う試験で Terraform の試験（`terraform/tests/*.tftest.hcl`）と同じ性質を検査する。**二重に apply しない**: Pulumi の `up` は、本人が「Terraform を使わない（または import が済んだ）」と判断してから。
- 切替の手順（本人の承認後。§6）: 実リソースの有無を確認 → 無ければ Pulumi で新規作成、有れば `pulumi import`（または Terraform state からの変換）→ `pulumi preview` が差分 0 を確認 → Terraform の定義とワークフローを削除。
- 版は npm の公開日で確認し、公開から 2 週間以上の安定版に固定する（§7）。

## 2. 対応表（Terraform → Pulumi。リソースの論理名は Terraform のアドレスと 1 対 1）
| Terraform | Pulumi（@pulumi/gcp） | 注意 |
|---|---|---|
| `google_project_service.api[*]` | `gcp.projects.Service`（`disableOnDestroy: false`） | 14 API |
| `google_compute_network.main`・`subnetwork.run`・`global_address.private_services`・`service_networking_connection.private_services` | `gcp.compute.Network`・`Subnetwork`・`GlobalAddress`・`gcp.servicenetworking.Connection` | Direct VPC egress（コネクタ・NAT・LB なし） |
| `google_artifact_registry_repository.images` | `gcp.artifactregistry.Repository`（cleanupPolicies 2 本） | |
| `google_storage_bucket.*`・`*_iam_member` | `gcp.storage.Bucket`・`BucketIAMMember`（IAM 条件はそのまま） | ops_state・model_store は enforced、mode_beacon だけ allUsers 読取り |
| `google_service_account.sa[*]` | `gcp.serviceaccount.Account`（`sa-<key>`） | 9 SA。長期キーは作らない |
| `google_secret_manager_secret.secret[*]`・`_iam_member` | `gcp.secretmanager.Secret`・`SecretIamMember` | **値は管理しない**（版は本人が gcloud で入れる） |
| `google_project_iam_custom_role.*`・`google_project_iam_member.*`・`google_service_account_iam_member.*` | `gcp.projects.IAMCustomRole`・`IAMMember`・`gcp.serviceaccount.IAMMember` | 権限の一覧は同じ。setIamPolicy 系・run.jobs.run を含めない（試験） |
| `google_iam_workload_identity_pool(_provider).github` | `gcp.iam.WorkloadIdentityPool`・`WorkloadIdentityPoolProvider` | attribute_condition は infra リポジトリだけ。ワークフローと ref（main）で束縛 |
| `google_sql_database_instance.main`・`google_sql_database.jrabot` | `gcp.sql.DatabaseInstance`・`gcp.sql.Database` | `ignoreChanges: ["settings.activationPolicy", "settings.diskSize"]`（diskSize は I-041: 自動拡張後の縮小差分を防ぐ）（起動/停止は ops だけ） |
| `google_sql_user.db[*]`（`password_wo` + ephemeral） | **Pulumi では管理しない**（§3） | state に秘密を載せないため |
| `google_cloud_run_v2_service.dashboard/ingest`・`_iam_member`・IAP | `gcp.cloudrunv2.Service`・`ServiceIamMember`・`gcp.iap.WebCloudRunServiceIamMember` | `ignoreChanges`: ingress・client・clientVersion・イメージ・revision（ops・deploy が変更する値） |
| `google_cloud_run_v2_job.*`・`_iam_member` | `gcp.cloudrunv2.Job`・`JobIamMember` | `ignoreChanges`: client・clientVersion・イメージ（db-migration・ml-train は args も） |
| `google_cloud_scheduler_job.job[*]` | `gcp.cloudscheduler.Job` | 作成時は PAUSED、`ignoreChanges: ["paused"]` |
| `google_monitoring_*`・`google_billing_budget.monthly` | `gcp.monitoring.NotificationChannel`・`AlertPolicy`・`gcp.billing.Budget` | メール・請求アカウントが空なら作らない |
| `variable` の検証（digest・app_runtime の必須キー） | 設定を zod で検証（失敗したら定義を作らない） | タグ参照のイメージは拒否 |
| `output` | `export`（秘密を含まない値だけ） | ワークフローが参照する |

## 3. 秘密と state
- **DB ユーザーのパスワード**: Terraform は write-only 引数（`password_wo`）と ephemeral の Secret Manager 参照で state に残さなかった。@pulumi/gcp 10.2.0 にも `passwordWo` はあるが、**Pulumi が入力値を state（checkpoint の inputs）に記録しないことを確認できていない**。そのため Pulumi は DB ユーザーを作らず、ユーザーの作成とパスワードの設定は運用 CLI の明示操作（`ops db-users ensure`: Secret Manager の最新版を読み、SQL Admin API の users.insert / update で 1 回の呼出しで設定。パスワードの無いユーザーを作らない）に移す（**実装済み**: `node build/ops/src/cli.js db-users --project <id> [--rotate]`。試験 5 件。実 GCP では未検証。実行は本人）。
- **state**: DIY backend（GCS。`pulumi login gs://<tfstate バケット>/pulumi`）。このプログラムは Pulumi の秘密（`pulumi.secret`・secret config）を**入力に使わない**（preview-guard が入力の秘密の印を拒否する）。ただしプロバイダが出力を secret として扱う項目はある（Cloud SQL の `serverCaCerts` などの公開の証明書。Cloud Run の labels）。これらは秘密の値ではないので、秘密の暗号化の鍵（KMS は課金リソース）は置かず、`PULUMI_CONFIG_PASSPHRASE` は空で固定する（**秘密の値を state に入れないことが前提**。前提が崩れる変更は preview-guard が拒否する）。
- Secret Manager の**値**（版）は Pulumi も Terraform も管理しない（本人が gcloud で入れる）。

## 4. 起動状態を変えない（OPERATIONS_DESIGN §8 を維持）
- `ignoreChanges` で、ops が変更する値（Cloud SQL の activationPolicy・Cloud Run の ingress・Scheduler の paused）と deploy が変更する値（イメージ・revision・Job の args）を Pulumi が戻さない。
- **preview・up の前に必ず refresh する**（`Pulumi.yaml` の `options.refresh: always`。手順でも `--refresh` を付ける）。Terraform は plan の前に必ず refresh していたが、Pulumi は既定で refresh しない。refresh しないと、無視していない項目（env など）を変えたときの Cloud Run v2 の更新が資源全体を送り、state に残った作成時の ingress・イメージを書き戻す（サービスの停止と気づかないロールバック。レビュー 高）。refresh は ops・deploy の値を state に取り込み、`ignoreChanges` により差分にならない。**bridge の refresh が入力値（inputs。`template.containers[0].image` を含む）まで実際の値に更新するかは、実 GCP の preview で確認する項目**（§6）。
- **preview と up を同じ計画にする**: Terraform は保存した plan を検査して、その plan を apply していた。Pulumi の up は差分を計算し直すので、preview の後に ops-start などが動くと検査が効かない。ワークフローは ① ops のリースを取る（start/stop と同じ CAS。モードを固定）② refresh 付きの preview → `ops preview-guard` ③ 同じジョブで `pulumi up --refresh` を、保存した計画（`pulumi preview --save-plan` / `pulumi up --plan`。固定する CLI の版で利用できることを確認してから）に限定して実行 ④ リースを解放、とする（**未実装**。ワークフローと WIF の束縛の追加は本人承認の対象）。
- preview のガード（**実装済み**: `ops preview-guard --preview-json <file> --mode <mode> [--allow-destroy]`。試験 8 件）: plan-guard と同じ規則（遷移中のモードでは変更しない、保護する型の削除・置換の拒否、起動状態の変更の拒否、作成時の初期値、IAP・公開の主体、DB の変更は NORMAL だけ）に加え、sql.User・SecretVersion の管理と秘密の値（Pulumi の secret の印）を拒否。未確定の値・未知の op・解釈できない URN は拒否（fail closed）。

## 5. 試験（mock。GCP 認証なし）
- `pulumi.runtime.setMocks` でリソースを作らずに定義を評価し、Terraform の試験（base 20・deploy 13 の assert）と同じ性質を検査する: 公開アクセスの禁止、Cloud SQL の公開 IP なし・ENCRYPTED_ONLY・削除保護、DB ユーザーを作らない、WIF の条件と束縛、カスタムロールの権限（setIamPolicy 系・run.jobs.run を含めない）、Secret の数と値を持たないこと、デプロイ無効のときは Cloud Run・Scheduler を作らない、イメージは digest 参照だけ、ignoreChanges の対象、Scheduler は PAUSED で作る、など。
- **mock の成功は実 GCP の preview の成功ではない**（試験は定義の性質だけを見る）。

## 6. 本人の承認が必要な手順（この PR では行わない）
1. GCP プロジェクトの実リソースと Terraform state（GCS）の有無を確認する（`gcloud` / `terraform state list`）。
2. 無い場合: Pulumi のスタックを作り（`pulumi stack init prod`、backend は GCS）、`pulumi preview` → 承認 → `pulumi up`。続けて `ops db-users ensure` と `ops-stop`（初回は DB が起動中）。
3. 有る場合: `pulumi import`（リソースごと。ID は §2 の対応）→ `pulumi preview` が差分 0 → Terraform のワークフローを無効化 → 一定期間後に `terraform/` を削除。
4. どちらの場合も、`pulumi up` の前に `terraform apply` のワークフローを止める（二重に apply しない）。

## 7. 版（npm の公開日。確認日 2026-11-03）
| パッケージ | 版 | 公開日 | 備考 |
|---|---|---|---|
| @pulumi/pulumi | 3.270.0 | 2026-10-16 | 3.271〜3.273 は 2 週間未満。peerDependency は typescript < 7（使っているのは 6.0.3） |
| @pulumi/gcp | 10.2.0 | 2026-10-20 | 10.2.1・10.2.2 は 2026-11-02 で 2 週間未満 |
| Pulumi CLI | （未導入） | - | preview・up は本人の環境または承認後のワークフローで。版は導入時に公式の配布物の SHA256 で確認して固定する |

### 7.2 後続（低。レビューの指摘で未対応のもの）
- @pulumi/* は `dependencies` にあり、本番の WIF 資格情報を持つ ops 系ワークフローの `npm ci` でも導入される（攻撃面と時間）。Pulumi の定義を別のパッケージ（npm workspace）に分けて、ops のワークフローでは入れない。
- 試験が資源の型・入力・オプションを受け取るのに `transformations`（非推奨）を使っている。`transforms` は mock では使えないので当面このまま。
- preview の前に `npm run build`（Pulumi.yaml の `main` は `../build/pulumi/src/index.js`。ESM の読み込みは Pulumi CLI が未導入のため未確認）。設定は `jrabot:` の名前空間（`pulumi config set jrabot:projectId <id>`。配列・オブジェクトは JSON の文字列）。
- ガードへの追加の提案（plan-guard にも無い）: WIF の attributeCondition・カスタムロールの権限の追加・`publicAccessPrevention`・`ipv4Enabled` の変更を拒否する。

### 7.1 npm audit（2026-11-03）
`npm audit` は moderate 20 件。すべて @pulumi/pulumi が依存する npm の内部ツール（@npmcli/*・pacote・sigstore・tuf-js）が使う `glob`（GHSA-3g3m-2fjr-6pw4: AbortSignal でのキャンセルの迂回）と `minimatch`（GHSA-g3hv-75wg-m249: パターンの増幅によるサービス妨害）。どちらも**攻撃者が指定するパターン・入力**が前提で、このリポジトリのプログラム（定義の評価と mock の試験）は外部入力のパターンを渡さない。`npm audit fix --force` の提案は @pulumi/pulumi 3.107.0（大幅な格下げ）で採らない。`overrides` で推移的依存の版を上げると @npmcli の API の互換が崩れ得るので使わない。@pulumi/pulumi の更新で解消したら記録を消す。
