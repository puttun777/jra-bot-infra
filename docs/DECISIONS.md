# DECISIONS（infra）
| ID | 日付 | 判断 | 状態 |
|---|---|---|---|
| I-001 | 2026-10-22 | 本リポジトリは空のため作業ブランチ `claude/stage0-bootstrap` に push。`main` 未作成のため PR はユーザーによる main 初期化待ち（web D-001 と同じ） | 要ユーザー対応 |
| I-002 | 2026-10-22 | 要件/計画/契約の正本は web。infra は固有仕様のみ | 確定 |
| I-003 | 2026-10-22 | `terraform apply` と課金リソース作成はユーザー承認後のみ | 確定 |
| I-004 | 2026-10-22 | クラウドは GCP 固定ではない。費用比較（T1.6）後に決定 | 解消（I-011 で GCP を設計採用） |
| I-005 | 2026-10-22 | T1.6 の比較結果は「推奨案」を示すが**クラウド選定（T1.7）は未決定**。推奨=GCP G1（Cloud Run + Cloud SQL 共有コア）、次点=G1m / AWS A1 | 決定権はユーザー | 提案 |
| I-006 | 2026-10-22 | 試算の為替は 1USD=156円、税抜、DB 20GB、bot 100h を基準。Cloud SQL 東京は Iowa×1.30 の推定（ランクB）、Azure はランクC（参考） | 公式東京単価・Azure 公式料金に到達できず（CLOUD_COSTS §0） | 確定（仮定） |
| I-007 | 2026-10-22 | AWS App Runner は新規受付停止（2026-04-30〜）のため候補から除外 | AWS ドキュメント（検索結果経由） | 確定 |
| I-008 | 2026-10-22 | 運用モードの desired 正本は DB 非依存のオブジェクトストア。DB 内は表示用コピー（web D-005 と整合） | DB 停止中も読み書き可能にするため | 案（T1.8） |
| I-009 | 2026-10-22 | Cloud SQL を採用する場合は Enterprise エディションを明示、プライベート IP のみ（9.7 の既定=Enterprise Plus と、停止中の公開 IPv4 課金 $0.01/h を避ける） | CLOUD_COSTS §2.1 | 案（T1.7 採用時） |
| I-010 | 2026-10-22 | 「Web 24h 閲覧可 + DB 停止」案（静的エクスポート）は要件と矛盾するため推奨しない | CLOUD_COSTS §6.5 | 提案 |
| I-011 | 2026-10-22 | **GCP を設計上採用**（Cloud Run: dashboard / ingest、Cloud Run Jobs: bot・calendar-check・reconcile・retention・db-migration・export-dataset・ml-train、Cloud SQL for MySQL、Scheduler、Artifact Registry、Secret Manager、GCS、直接 IAP、GitHub Actions + WIF、Terraform）。**契約・課金リソース作成の承認ではない** | ユーザー方針 + CLOUD_COSTS §10.5（重大な費用問題なし、停止要件・運用性・アクセス制御を優先）。代替は ARCHITECTURE §9 | 確定（設計） |
| I-012 | 2026-10-22 | Cloud SQL は **Enterprise エディション（明示指定）+ db-g1-small**、SSD 20GB（自動拡張上限 50GB）、プライベート IP のみ、自動バックアップ 7 世代、PITR 初期オフ、HA なし。**db-f1-micro は検証なしに採用しない**。共有コア不可時の代替は db-custom-1-3840 | 共有コアは Enterprise のみ、8.4/9.7 の既定は Enterprise Plus。f1-micro は 0.6GB でメモリ不足の恐れ | 確定（設計）/ G-DB-1 で検証 |
| I-013 | 2026-10-22 | **MySQL 8.4 LTS を暫定基準**。9.7 は第2段階で Flyway 13.11.1 + Connector/J 9.7.0 + Doma 3.14.1 の互換検証（Testcontainers）と Cloud SQL 9.7 の Enterprise 共有コア可否を確認後に再判断 | Flyway の検証済み版に 8.4/9.7 の明記なし（5.7/8.0/9.4）。ユーザー方針「互換性が確認できない場合は 8.4」。web D-015 の更新を引継ぎ（CONTRACTS D10） | 確定（暫定） |
| I-014 | 2026-10-22 | 運用モードは **NORMAL / STARTING / STOPPING / STOPPED** の 4 値。desired（NORMAL/STOPPED）と mode（現在フェーズ）と actual（計測値）を区別。途中失敗は STARTING/STOPPING のまま（自動で NORMAL に戻さない） | OPERATIONS_DESIGN §1 | 確定（設計） |
| I-015 | 2026-10-22 | 状態の正本は **GCS `ops-state.json`**（非公開・バージョニング・CAS〔ifGenerationMatch〕・リース 90 分・履歴追記）。ビーコンは**専用の公開バケット**に署名付きで 1 オブジェクトのみ。署名鍵は Secret Manager | DB 非依存、低コスト、競合検出。web I-008/D-005 と整合 | 確定（設計） |
| I-016 | 2026-10-22 | start/stop/status の手順と失敗時の扱い（OPERATIONS_DESIGN §5〜§7）。dashboard/ingest の停止は **ingress=internal**（IAP・IAM・許可リストは STOPPED 中も変更しない） | 認証を緩める操作を含めない。冪等 | 確定（設計）/ G-OPS-1 |
| I-017 | 2026-10-22 | モード制御属性は ops ワークフローのみが書く。Terraform は `ignore_changes` に加え**apply 前ガード**（plan JSON の検査、STOPPED 中の DB 変更拒否、replace 検出）、作成時は停止側の初期値（DB=NEVER、ingress=internal、Scheduler=paused）、deploy は STOPPED 中既定で拒否 | ignore_changes だけに依存しない（ユーザー要件） | 確定（設計）/ G-OPS-9 |
| I-018 | 2026-10-22 | **自動修復しない**: 定期 status（毎日）は不整合を通知するのみ。DB を起動できるのは ops の start だけ（ランタイム SA に Cloud SQL 管理権限を与えない）。Jobs は max-retries=0 | 意図しない課金の防止 | 確定（設計） |
| I-019 | 2026-10-22 | ネットワークは Direct VPC egress（プライベート範囲のみ）+ プライベートサービスアクセス。**コネクタ・Cloud NAT・LB は使わない** | 固定費ゼロ | 確定（設計）/ G-NET-1 |
| I-020 | 2026-10-22 | 組織なしプロジェクトの直接 IAP は**カスタム OAuth クライアントを手動作成**（Terraform で作れない）して運用。初期は IAP 許可を誰にも付けない（全拒否） | 公式ドキュメント抜粋 | 確定（設計）/ G-OPS-8 |
| I-021 | 2026-10-22 | 費用見積りの基準は「無料枠除外」額。GCP 通常運用 ≈ ¥8,550/月（東京推定）、全停止 ≈ ¥1,200/月 | ユーザー方針（無料枠・クレジット前提にしない） | 確定（推定値） |
| I-022 | 2026-10-22 | 契約の正本は web。差異 D1〜D12（CONTRACTS §2）は Stage 1-D② で web 側を修正 | I-002 | 引継ぎ |
