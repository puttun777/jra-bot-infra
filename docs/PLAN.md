# PLAN（インフラ担当分）

全体計画・依存の正本: jra-bot-web `docs/PLAN.md`。ここは infra 担当タスクの抜粋。

- [x] T0.x 第0段階
- [x] T1.6 CLOUD_COSTS.md（2026-10-22）
- [x] T1.7 クラウド/DB 選定（2026-10-22 **設計上の採用**: GCP、Cloud SQL Enterprise db-g1-small、MySQL 8.4 暫定。I-011〜I-013。契約・課金は未承認）
- [x] T1.8 運用モード・起動停止方式の確定（2026-10-22 OPERATIONS_DESIGN.md。実検証は G-OPS-*）
- [x] T1.18 web ⇔ infra 契約同期（2026-10-22 CONTRACTS.md。差異 D1〜D12 は web 側で修正＝Stage 1-D②）
- [x] T1.14 確認（一部）: Enterprise のみ共有コア・既定 Enterprise Plus を確認。**東京正式単価・8.4 での g1-small 可否・停止中メンテナンス・IAP 料金は未確定** → 検証ゲートへ
- [ ] **ユーザー確認（課金不要）**: G-COST-1 東京単価（料金計算機/作成画面の見積り）、G-DB-1 MySQL 8.4 Enterprise で db-g1-small が選べるか（作成画面で確認のみ、作成しない）

## 検証ゲート（実リソースが必要 = ユーザー承認後）
| 段階 | ゲート | 内容 |
|---|---|---|
| 第2段階 | G-DB-0 | Testcontainers: MySQL 8.4 / 9.7 × Flyway 13.11.1 × Connector/J 9.7.0 × Doma 3.14.1（I-013） |
| 第2段階 | G-DB-4 | 負荷の目安（オッズ書込・集計クエリ）をローカル MySQL で測定 |
| 第2段階 | G-DB-5 | IAM DB 認証を JDBC で使えるか（不可ならパスワード + Secret Manager） |
| 第5段階 | G-COST-1 / G-DB-1 | 東京単価と共有コア可否（作成前に確認） |
| 第5段階 | G-OPS-1〜9 | OPERATIONS_DESIGN §12（ingress 停止、停止/起動時間と課金、停止中メンテナンス、Job cancel、Jobs 最大時間、CAS、IAP プログラム通過、組織なし IAP、apply 前ガード） |
| 第5段階 | G-NET-1 | Direct VPC egress + プライベートサービスアクセスの課金・疎通、インターネット宛のみ外部へ出ること |

## 第5段階（実装）
- [ ] T5.1 Terraform 基盤（tfstate バケット、WIF、AR、Secret、VPC、バケット 4 種）
- [ ] T5.2 Cloud SQL / Cloud Run（dashboard・ingest）/ Jobs / Scheduler / IAP（作成時は停止側の初期値: I-017）
- [ ] T5.3 deploy ワークフロー（release-manifest 入力、NORMAL 必須、migrate → 更新）
- [ ] T5.4 ops-start / ops-stop / ops-status（OPERATIONS_DESIGN §5〜§7、Job Summary）
- [ ] T5.5 apply 前ガード（plan JSON 検査）と非干渉テスト
- [ ] T5.6 監視（定期 status + Discord、予算アラートはユーザー作業）、ロールバック、OPERATIONS.md（Runbook）
- apply・課金リソース作成は常にユーザー承認後
