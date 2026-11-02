# OPERATIONS（Runbook）
最終更新: 2026-11-01。対象: 本人 1 名の運用。**ここに書いた手順のうち実 GCP に触れるものは、まだ一度も実行していない**（検証ゲート G-OPS-1〜9 は `OPERATIONS_DESIGN.md` §12）。実行したら結果（成否・件数のみ。秘密は貼らない）を `docs/PROGRESS.md` に記録する。
設計の正本: `OPERATIONS_DESIGN.md`（モード・手順・ガード）。コードの正本: `ops/`（TypeScript。`node build/ops/src/cli.js`）、`terraform/`、`.github/workflows/`。

## 0. 前提となる本人の作業（Claude はできない・しない）
| # | 作業 | 結果として得るもの |
|---|---|---|
| U1 | GCP プロジェクトを作り、請求アカウントを紐付ける | `project_id`, `project_number` |
| U2 | tfstate 用バケットを作る（§1）。**これは課金リソースだが極小** | `<project_id>-tfstate` |
| U3 | このリポジトリの GitHub Environments を作る: `terraform`（必須レビュー = 本人）、`ops`、`deploy`（必要なら必須レビュー） | Environment |
| U4 | リポジトリ変数を設定（Settings → Variables）: `GCP_PROJECT_ID` `GCP_PROJECT_NUMBER` `GCP_WIF_PROVIDER` `GCP_SA_OPS` `GCP_SA_DEPLOY` `GCP_SA_TF` | 変数 |
| U5 | 組織なしプロジェクトの IAP 用 OAuth クライアントを Console で作成（Terraform では作れない。G-OPS-8） | クライアント ID/Secret → Secret Manager |
| U6 | Secret の値を入れる（§3）。Discord Webhook・ingest-token-pepper・agent-kek・鍵 | Secret |
| U7 | 予算アラート: `billing_account_id` を変数に渡せば Terraform が作る（請求アカウントの権限が必要）。権限を付けたくなければ Console で手動作成 | 通知先メール |
| U8 | `terraform apply` を**承認して実行**（§2） | 資源 |

## 1. 初期導入の順序（初回のみ）
1. **tfstate バケット**（bootstrap）: `gcloud storage buckets create gs://<project_id>-tfstate --location=asia-northeast1 --uniform-bucket-level-access --public-access-prevention` と `gcloud storage buckets update gs://<project_id>-tfstate --versioning`。
2. **WIF と SA の最初の 1 回だけは手元から**: GitHub Actions が使う WIF 自体を Terraform が作るため、最初の apply はローカル（本人の認証）で行う。以後は workflow に移す。
3. **Secret の箱だけ先に作る**（DB のパスワードは Secret Manager の値を ephemeral で読むため、値が無いと全体の apply が失敗する）: `terraform apply -target=google_project_service.api -target=google_secret_manager_secret.secret`。続けて §3 で値を入れる。
4. **基盤の apply（`release_images=null`）**: 通常の `terraform apply`。DB・ユーザー・WIF・バケット・Secret の権限などができる。Cloud Run の service / Job / Scheduler は **まだ作られない**（release が無いため）。
5. **この時点で DB は起動していて課金中**（`activation_policy=ALWAYS`。DB・ユーザーの作成に起動が必要なため）。ops-stop は Scheduler / service が無いので使えない。**手元で直接止める**: `gcloud sql instances patch jra-bot-db --activation-policy=NEVER`。`ops-state` の初期値は STOPPED なので、以後の状態と一致する。
6. web の release（イメージ + `release-manifest.json`）ができたら、`terraform.tfvars`（コミットしない）に `release_images` と `app_runtime` を入れて 2 回目の apply（Cloud Run の service / Job / Scheduler が **停止側の初期値**〔ingress=internal、paused〕で作られる。DB は停止のまま〔`ignore_changes`〕）。以後のイメージ更新は **deploy workflow**（Terraform はイメージを見ない）。
7. 動かす時: **ops-start**（`apply_pending_migrations=true`）→ **ops-status**（全行 ✅）。止める時: **ops-stop**。

## 2. Terraform（`terraform-plan.yml` / `terraform-apply.yml`）
- 手元の確認: `cd terraform && terraform fmt -check -recursive && terraform init -backend=false -lockfile=readonly && terraform validate && terraform test`（**mock の成功は実 GCP の plan 成功ではない**）。
- ローカルで plan/apply する場合: `terraform init -backend-config="bucket=<project_id>-tfstate"`、`TF_VAR_project_id` `TF_VAR_project_number` を環境変数で渡す。**apply は本人が内容を読んで実行する**。
- workflow: `terraform-plan`（main から手動）→ `ops/…cli plan-guard` が拒否しなければ要約を表示。`terraform-apply` は Environment `terraform` の承認後に plan → ガード → apply を同じジョブで行う（`confirm=apply` が必要）。
- **ガードが拒否するもの**: Cloud SQL の `activation_policy`・Cloud Run の `ingress`・Scheduler の `paused` の変更 / 保護資源（Cloud SQL・バケット・Secret・Artifact Registry）の削除・置換 / `allUsers` 等の付与（ingest と beacon バケットを除く）/ IAP の無効化 / STOPPED・遷移中の DB 変更。意図した削除は `allow_destroy=true`（Environment の承認画面で内容を確認）。

## 3. Secret（値は Git に置かない）
`gcloud secrets versions add <name> --data-file=-` で標準入力から入れる（履歴に残さない）。名前: `db-app-password` `db-ingest-password` `db-bot-password` `db-migrate-password` `db-mltrain-password` `discord-webhook` `discord-error-webhook` `ingest-token-pepper` `agent-kek` `beacon-signing-key`（Ed25519 の生 32 バイトを Base64）`model-signing-key`。
- 鍵の生成例（出力をログ・チャットに貼らない）: `openssl rand -base64 32`
- **鍵の更新**: ① 新しい鍵を新バージョンとして追加 ② 新しい `kid` を決め、ビーコンの公開鍵を取得側（Windows エージェント設定）に**先に**追加 ③ ops-start/ops-stop のどちらかを `force` なしで実行してビーコンを再署名 ④ 古い鍵を取得側から外す。`agent-kek` の更新は web の `docs/CONTRACTS.md`（エージェント資格の再暗号化）に従う（P-1 の承認が先）。

## 4. 起動・停止・状態（`ops-start` / `ops-stop` / `ops-status`）
- いずれも **main の workflow を手動実行**。入力に理由が必須。`concurrency: ops-prod` で同時に 1 つだけ。リース（90 分）と GCS の CAS でも直列化される。
- **途中で失敗したら**: ジョブのログと Job Summary の表（❌ の行）を見る → 原因を直す → **同じ workflow を再実行**（完了済みのステップは実状態を測ってスキップ。失敗を理由に NORMAL へ戻さない）。
- 症状別の対処は `OPERATIONS_DESIGN.md` §10。要約: `STARTING(FAILED)` → start を再実行 / `STOPPING(FAILED)` → stop を再実行（Job が残る場合は手動 cancel） / リースが残る → 90 分待つか `force=true` + 理由 / STOPPED なのに DB が RUNNABLE → stop を再実行（修復）。
- **GitHub Actions が使えない時の最終手段**: Console で `OPERATIONS_DESIGN.md` §5/§6 の順序を手作業で実行し、**GCS の `state/ops-state.json` も更新**する（更新しないとアプリが誤動作する）。
- 定期 status（毎日 09:17 JST）: 不整合があれば Discord のエラー Webhook に通知。**自動修復はしない**。

## 5. デプロイ（`deploy.yml`）とロールバック
- 入力は web の `release-manifest.json`（URL + SHA-256）だけ。検証: スキーマ（`schemas/release-manifest.v2.json`、web の写し）・プロジェクトの一致・digest 固定・`contract_version` 0.4.x・プレビュー拒否。
- 順序: db-migration のイメージ更新 → `validate`（0 / 10 / 1 / 75）→ 10 なら `migrate` → 再 validate が 0 → 各 Job → ingest → dashboard → ヘルスチェック → **ingress/IAP が deploy の前後で不変**。`mode=NORMAL` 以外は既定で拒否（`allow_when_stopped` はイメージ参照のみ・migration なし）。
- **ロールバック**: アプリは前の manifest で deploy を再実行（`rollback.min_app_release` 以上のみ。スキーマは前進のみで、migration の巻き戻しはしない = 後方互換な migration しか入れない設計）。DB に問題があるときは §6 の復元。
- `deploy` が validate で拒否しても db-migration の Job のイメージは新しい版のまま残る。**直後に ops-start を `apply_pending_migrations` 付きで実行しない**（検証されていない版が適用され得る）。前の manifest で deploy をやり直してから行う。
- 失敗の読み方: validate が 1 → スキーマ不一致または失敗した migration（アプリは更新されていない）/ 75 → DB 不達（start されていない可能性。status）/ ヘルスチェック失敗 → 前の manifest で再 deploy。

## 6. バックアップ・復元
- Cloud SQL の自動バックアップ 7 世代（`terraform/cloudsql.tf`。ポイントインタイムリカバリは無効 = 損失許容は最大 1 日。必要なら有効化を判断）。停止前のオンデマンドは `ops-stop` の `take_backup=true`。
- 復元（**本番 DB の上書きは本人の判断**）: `gcloud sql backups list --instance=jra-bot-db` → 別インスタンスへ復元して中身を確認 → 問題なければ切替。手順は実機で未検証（G-DB-*）。
- ops-state の復元: GCS のオブジェクトバージョンから直前版を戻す（`gcloud storage cp gs://<bucket>/state/ops-state.json#<generation> gs://<bucket>/state/ops-state.json`）→ ops-status。

## 7. 費用と監視
- 予算アラートは U7（`billing_account_id` が空なら作られない）。Cloud Monitoring のアラートポリシーは最小限（`terraform/monitoring.tf`、`alert_email` が空なら作らない）。主な検知は定期 status。見積り: `CLOUD_COSTS.md` §10（通常 ≈ ¥8,550/月、全停止 ≈ ¥1,200/月。東京の単価は推定）。
- **停止し忘れの検知**: STOPPED なのに DB が RUNNABLE ＝ status が ❌（課金中）。

## 8. 検証済み / 未検証の区別
| 項目 | 状態 |
|---|---|
| `ops/` の start/stop/status/deploy/plan-guard/アダプタのロジック | 偽の GCP・GCS で単体試験済み（`ops/tests`）。**実 GCP の応答との一致は未検証** |
| Terraform | `fmt` / `validate`（実プロバイダのスキーマ）/ `terraform test`（mock）済み。**実 GCP に対する `plan` は未実施**（認証が必要） |
| workflow | YAML 構文のみ。**GitHub 上での実行は未実施**（Environment・変数・WIF の設定後に実行） |
| 検証ゲート G-OPS-1〜9 | 未実施（実リソースが必要） |
| 追加の未確認（独立レビュー由来） | G-OPS-10: `gcloud run jobs execute --wait` 失敗時に db-migration の終了コード 10 を取れるか（取れないと start/deploy は『未適用あり』を『不整合』として止まる = 安全側）。キャンセル時に runner のシグナル（SIGINT → 約 7.5 秒後に SIGTERM → SIGKILL）が `python | tee` の python まで届き、リース解放の commit が間に合うか（G-OPS-11。解放は計測より先に書く設計）、DB が停止中に `terraform plan`/`apply` の refresh が Cloud SQL のユーザー・DB を読めるか（読めない場合は apply の前に ops-start が必要になる）、IAP のサービスエージェント（`service-<番号>@gcp-sa-iap…`）が apply 時点で存在するか、IAP の audience、`ingress=internal` の外部応答コード |

## deploy とロールバックの下限（2026-11-02、I-030・I-032・I-033）
- 前進の deploy は、db-migration のイメージを替える**前に** `ops-state.release.schema_min_app_release` を `max(記録, manifest の min_app_release)` へ上げて記録する（migrate の途中で中断されても、Cloud Run 上の migrate が続いて DB が進み得るため）。migrate を一度も実行しないまま失敗した場合（validate で止まった・アプリの更新で失敗した）は、元の記録に戻す。
- **誤って互換性を壊すリリースを STOPPED で deploy した場合**（DB は旧スキーマのまま）、下限が上がってロールバックできなくなる（安全側）。戻すには: ① `gcloud storage cat gs://<project>-ops-state/state/ops-state.json` で現在の記録を確認する ② 直前の release の記録は `history/` にある（同じ名前の上書き不可） ③ **本人が**、ops のリースが無いこと（`ops-status`）を確かめたうえで、`release.schema_min_app_release` を直前の値に戻した JSON を `--if-generation-match=<現在の generation>` で書き戻す。Claude は本番の ops-state を書き換えない。
- 要検証（G-OPS-11）: キャンセル時に node へシグナルが届くか（`node … | tee`）。中断時は履歴の書込みを省き、本体の状態（解放・FAILED）を優先して書く。
