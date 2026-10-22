# PROGRESS（jra-bot-infra）
最終更新: 2026-10-22（Stage 1-D①: T1.7・T1.8・T1.18 完了）

## 現在の段階
第1段階の infra 担当分は**設計確定**（T1.6/T1.7/T1.8/T1.18）。次は web 側の **Stage 1-D②（T1.10 アプリ全体設計の確定）**。その後 第2段階（web 基盤）→ 第5段階（infra 実装）。

## 今回の完了（claude/stage1-finalize-infra）
- **T1.7**: GCP を**設計上採用**（I-011。契約・課金の承認ではない）。Cloud SQL = Enterprise（明示）+ db-g1-small、MySQL **8.4 LTS 暫定**（9.7 は互換検証後）、プライベート IP のみ、SSD 20GB、バックアップ 7 世代（I-012/I-013）。`ARCHITECTURE.md` を GCP 構成で全面更新（コンポーネント設定、Cloud SQL 選定表、セキュリティ境界、組織なし IAP、デプロイ、代替案）
- **T1.8**: `OPERATIONS_DESIGN.md`（新規）: 4 モードと遷移規則、GCS 正本（CAS・リース・版管理・履歴）、署名付きビーコン、各リソースの操作、start/stop/status の手順と失敗時の扱い、影響マトリクスと apply 前ガード、自動修復しない方針、監視、手動復旧、IAM、検証ゲート G-OPS-1〜9
- **T1.18**: `CONTRACTS.md` を web 0.3.0 に同期（実現方法の対応表）。**差異 D1〜D12** を web 側修正事項として整理、`release-manifest.json` のスキーマ案
- **費用**: `CLOUD_COSTS.md` §10（無料枠除外を基準に再計算: 通常 ≈ ¥8,550/月、全停止 ≈ ¥1,200/月〔東京推定〕）
- `DECISIONS.md` I-011〜I-022、`PLAN.md`（検証ゲート表）、`REQUIREMENTS.md`

## 確認できたこと / できなかったこと
| 項目 | 結果 |
|---|---|
| 共有コアは Enterprise のみ、8.4/9.7 の既定は Enterprise Plus | 公式ドキュメントの検索抜粋で確認 |
| 停止中は「開始するまで停止のまま」、ストレージ・IP は課金継続 | 同上 |
| 組織なしでも直接 IAP 可、外部ユーザーはカスタム OAuth クライアント（Terraform で作成不可） | 同上 |
| Logging 50GiB/月無料、Monitoring アラート課金は 2027-09 から、Direct VPC egress はコネクタ課金なし | 公式ページ/抜粋 |
| **Cloud SQL 東京の正式単価** | **未取得**（料金ページの地域切替が JS 動的。ヘッドレスブラウザでも選択できず）→ Iowa×1.30 推定のまま |
| MySQL 8.4 での db-g1-small 提供可否、停止中のメンテナンス挙動、IAP 料金、プライベート IP の停止中課金、Flyway の 8.4/9.7 正式対応 | **未確認** → ゲート |

## テスト結果
該当なし（設計のみ。課金リソース・Terraform・GCP 契約の変更なし）。

## 未解決（ユーザー）
1. **G-COST-1 / G-DB-1（課金不要）**: GCP 料金計算機またはコンソールの Cloud SQL 作成画面（作成はしない）で、東京・Enterprise・MySQL 8.4・db-g1-small の単価と選択可否を確認。
2. GCP プロジェクト/請求アカウントの有無（第5段階まで不要）。予算アラートの設定（請求側の作業）。
3. web からの Artifact Registry への push 権限（第5段階で WIF を追加するか）。
4. 継続: JRA-VAN 問い合わせ（クラウドへ実データを置く可否）、2 人目の契約。

## Stage 1-D② への引継ぎ（web リポジトリで実施）
- **CONTRACTS の修正 D1〜D12**（モードのフィールド統一、ビーコン鍵の保管場所、`/internal/*` の機械認証、ModeProvider の読み方、エージェント最終接続の GCS 写し、start 時の migrate、release-manifest スキーマ、DB 接続/プール、Jobs 終了コード、MySQL 8.4 暫定、STOPPED 中 dashboard 到達不能、ml-train の DB 権限）→ contract 0.4.0
- web `docs/PLAN.md` の T1.7/T1.8/T1.18 を完了に更新（本 PR は infra のみ）
- web `VERSIONS.md` / `DECISIONS.md` D-015 を I-013 に合わせて更新
- T1.10 で確定すべき web 側の案（D-018〜D-044）のうち infra に影響するもの: `:ingest` の独立デプロイ、`export-dataset` タスク、`ml-train` イメージ、tenant_id（バケットのパス分割）

## Git
- ブランチ: `claude/stage1-finalize-infra`（base: main 6a97272）
- コミット/PR: push 後に記録
