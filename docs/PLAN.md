# PLAN（インフラ担当分）

全体計画・依存の正本: jra-bot-web `docs/PLAN.md`。ここは infra 担当タスクの抜粋。

- [x] T0.x 第0段階（確認・docs・ブランチ）。PR は main 未作成のためブロック
- [x] T1.6 CLOUD_COSTS.md（GCP/AWS/Azure、条件A/B/C。2026-10-22 完了。東京の Cloud SQL 実額・Azure は未確認項目あり＝CLOUD_COSTS §7）
- [ ] T1.7 クラウド/DB 決定（**ユーザー判断待ち**。推奨は CLOUD_COSTS §5.5。先に §7 の確認 1〜3 を実施）
- [ ] T1.8 運用モード正本・STOPPED 方式の**確定**（事前調査は完了＝CLOUD_COSTS §4・§6、ARCHITECTURE 要約。T1.7 後に採用クラウドで確定）
- [ ] T5.1 Terraform 基盤（state, WIF, Registry, Secret）
- [ ] T5.2 Web/Job/DB/Scheduler/IAP
- [ ] T5.3 deploy workflow ← web の release-manifest
- [ ] T5.4 start/stop/status
- [ ] T5.5 Terraform 非干渉の検証
- [ ] T5.6 監視/予算/ロールバック
- apply・課金リソース作成は常にユーザー承認後
- [ ] T1.14 （新）Cloud SQL 東京実額・共有コア可否・直接 IAP 料金・停止中メンテナンスの確認（ユーザー側の料金計算機/コンソールが最短）
- [ ] T1.15 （新）web CONTRACTS に「STOPPED で拒否/到達不能＝エージェント送信しない」を追記（web リポジトリのセッション）
