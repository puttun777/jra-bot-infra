# REQUIREMENTS（インフラ固有）

アプリ全体要件の正本: jra-bot-web `docs/REQUIREMENTS.md`。ここは差分と詳細化のみ。

## 1. クラウド
- 第一候補 GCP: Cloud Run（Web）、Cloud Run Jobs（bot/migrate）、Cloud SQL for MySQL、Cloud Run 直接 IAP、Artifact Registry、Cloud Scheduler、Secret Manager、Terraform。
- 比較対象: Azure Container Apps + 各DB、AWS ECS Fargate + RDS + ALB。GCP 固定ではない。要件を満たし**継続費用が安い**構成を選ぶ。
- 日本リージョン優先。

## 2. 費用比較（第1段階 `CLOUD_COSTS.md`）
- 条件A: ダッシュボード常時利用可、bot は開催日のみ（月 8〜12 日 × 各 8〜12 時間、実開催で補正）。
- 条件B: 1か月全体停止、データのみ保持。
- 条件C: 利用者増加（100 / 1,000 人）。
- 含める費用: 計算、DB、ストレージ、ネットワーク、バックアップ、監視、レジストリ、GitHub Actions 等。公式価格・確認日・通貨・税・換算条件を記録。**無料枠と新規契約クレジットを分離**。停止中に残る料金、DB の停止/自動再起動仕様（例: 一定期間後の自動再起動の有無）を必ず確認。

## 3. 運用モードと一括起動/停止
- （2026-10-22 確定）モードは NORMAL / STARTING / STOPPING / STOPPED。確定設計は `OPERATIONS_DESIGN.md`。
- GitHub Actions `workflow_dispatch` で `start` / `stop` / `status` をそれぞれ 1 回の実行で。
- 起動: DB 復帰 → Web 復帰 → 正常性確認 → bot 制御再開。停止: 新規実行抑止 → Web・ジョブ停止 → DB アクセス終了 → DB 停止。
- desired（希望モード）と actual（実リソース状態）を区別して表示。一部失敗時の状態表示、安全な再実行（冪等）、排他制御（`concurrency`）。
- Terraform apply/デプロイは mode と DB 稼働状態を変更しない（`lifecycle.ignore_changes` 等、検証 T5.5）。
- クラウド制約で満たせない部分は代替案と残る制約を `ARCHITECTURE.md` に明示。

## 4. セキュリティ
- 最大 2 人の許可リスト。初期未設定は全拒否。一般/管理者/機械連携の主体分離（個別 SA）。
- GitHub OIDC + Workload Identity Federation。長期鍵なし。最小権限。Secret Manager。
- CI/CD 権限の範囲はユーザー確認なしに推測しない。

## 5. CI/CD
- Terraform: fmt/validate/plan（PR）、apply はユーザー承認付き environment。
- デプロイ: web の `release-manifest.json`（digest 固定）を入力。migrate Job → 更新の順。監視、ロールバック（直前 manifest へ戻す）。
- Renovate/Dependabot（Terraform provider, Actions のピン留め更新）。
