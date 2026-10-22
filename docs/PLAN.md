# PLAN（インフラ担当分）

全体計画・依存の正本: jra-bot-web `docs/PLAN.md`。ここは infra 担当タスクの抜粋。

- [x] T0.x 第0段階（確認・docs・ブランチ）。PR は main 未作成のためブロック
- [ ] T1.6 CLOUD_COSTS.md（GCP/Azure/AWS、条件A/B/C）
- [ ] T1.7 クラウド/DB 決定
- [ ] T1.8 運用モード正本・STOPPED 方式の検証（停止中課金、自動再起動、IAP、Scheduler）
- [ ] T5.1 Terraform 基盤（state, WIF, Registry, Secret）
- [ ] T5.2 Web/Job/DB/Scheduler/IAP
- [ ] T5.3 deploy workflow ← web の release-manifest
- [ ] T5.4 start/stop/status
- [ ] T5.5 Terraform 非干渉の検証
- [ ] T5.6 監視/予算/ロールバック
- apply・課金リソース作成は常にユーザー承認後
