# ARCHITECTURE（インフラ・暫定案、第1段階で確定）

## 構成案（GCP 第一候補。費用比較で変更し得る）
```
GitHub Actions (OIDC/WIF) ──> Artifact Registry (digest) ──> Cloud Run service: dashboard  (min=0, 直接IAP)
                          └─> Cloud Run Jobs: db-migrate / bot-run / bot-scheduler-check
Cloud Scheduler ──> bot-scheduler-check（軽量: 開催予定確認）──> bot-run（必要時のみ）
Cloud SQL for MySQL（停止可能）   Secret Manager   Monitoring/Alerting/Budget
jvlink-agent (Windows, ユーザーPC) ──HTTPS(機械用ID)──> ingest API
```
## 運用モード制御（案）
- desired 正本: DB 停止中も読める場所（例: GCS の小さな状態オブジェクト or Terraform 管理外の Secret/Parameter）。DB 内の値は表示用コピー。
- STOPPED 実現: Scheduler を pause、Cloud Run service は ingress を内部のみ/アクセス拒否（または 0 インスタンス+IAP 拒否）、Jobs は実行不可（実行主体の権限/モード確認）、Cloud SQL `activation-policy=NEVER`。
- 確認が必要な制約（T1.8）: Cloud SQL 停止中の課金（ストレージ/バックアップ/IPは継続）、停止後の自動再起動の有無、メンテナンス、IAP を止めずに「新規受付停止」する方法、Cloud Scheduler の pause と Terraform の衝突。
- Terraform: DB `activation_policy` や Scheduler 状態は `ignore_changes` とし、状態変更は start/stop workflow のみが行う。
## ワークフロー
`start` / `stop` / `status`（workflow_dispatch、`concurrency` で排他、各ステップを冪等・再実行可能に、結果を Job Summary に desired/actual 表で出力）、`deploy`、`terraform-plan`（PR）、`terraform-apply`（承認 environment）、`rollback`。
