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
- 確認が必要な制約（T1.8）は `CLOUD_COSTS.md` §4・§6 に調査結果を記録済み（候補ごとの実現可能性・制約）。最終方式はクラウド選定（T1.7）後に確定する。
- Terraform: DB `activation_policy` や Scheduler 状態は `ignore_changes` とし、状態変更は start/stop workflow のみが行う。
## ワークフロー
`start` / `stop` / `status`（workflow_dispatch、`concurrency` で排他、各ステップを冪等・再実行可能に、結果を Job Summary に desired/actual 表で出力）、`deploy`、`terraform-plan`（PR）、`terraform-apply`（承認 environment）、`rollback`。

## 運用モード制御：事前調査の要約（2026-10-22, T1.8 入力。決定ではない）
詳細と出典は `CLOUD_COSTS.md` §4・§6。
- **DB 停止の性質は候補で異なる**: GCP Cloud SQL=手動停止のまま継続（自動起動の記述なし・メンテナンスは要確認）/ AWS RDS=**7日で自動起動**（再停止ループ必須）/ Azure MySQL=**30日で自動起動** / Aurora Serverless v2=0 ACU で自動停止し**接続で自動再開**（遮断が必須）。いずれも**ストレージ・バックアップ課金は残る**（完全 0 円は不可）。GCP は公開 IPv4 を付けると停止中も +$7.3/月なので**プライベート IP のみ**。
- **desired の正本**: DB 非依存のオブジェクトストア（GCP: GCS、バージョニング + `ifGenerationMatch`）。actual は毎回 CLI で計測。Terraform は箱だけ作り中身は管理しない。
- **Terraform 非干渉**: 変更されうる属性（Cloud SQL `activation_policy`、Scheduler `paused`、Cloud Run `ingress`/IAP 許可）は `ignore_changes`。plan 差分テストで検証（T5.5）。実リソース PoC は承認後。
- **Windows エージェント**: STOPPED 時は Web が拒否/到達不能になるため、「拒否・到達不能＝送信しない」を契約化する（web CONTRACTS の更新が必要）。
- **start/stop/status**: 各1回の `workflow_dispatch` で実現可能。start=DB→(migrate)→Web→ヘルス→Scheduler、stop=desired書込→Scheduler停止→Job停止→Web拒否→DB停止。各ステップ冪等・`concurrency` で排他。
