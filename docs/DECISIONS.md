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
| I-023 | 2026-11-01 | **T5.0 完了（文書同期）**: infra の ARCHITECTURE・OPERATIONS_DESIGN・CONTRACTS を web CONTRACTS 0.4.15 に同期（I-H1〜I-H9。`CONTRACTS.md` §5）。UNKNOWN は exit 75、validate の終了コード 10、ビーコンは `phase` 廃止・`kid` 追加、DB ユーザー名と GRANT の所在、Jobs は bot イメージ + `--task=`、プール合計 24、スキーマ版 5、運用値の環境変数は**既定なしの必須入力**。コード・Terraform・課金リソースの変更なし。 |
| I-024 | 2026-11-01 | **ops は Python（標準ライブラリ + cryptography + google-cloud-storage）で実装し、GCP は `Gcp` ポートの背後に置く**。start/stop は『状態（GCS CAS）を最初に変える → 資源 → 検証』の冪等ステップ。試験は偽の GCP・GCS（`ops/tests`）。実 GCP との一致は G-OPS で確認 | OPERATIONS_DESIGN §5/§6 | 採用 |
| I-025 | 2026-11-01 | **workflow は第三者アクションを増やさない**: Terraform は版数 + SHA-256 を固定した composite（`setup-terraform`）、GCP 認証は `gcloud iam workload-identity-pools create-cred-config`（`gcp-auth`）。長期キーなし。checkout/setup-python/upload-artifact は web と同じコミット固定 | CLAUDE.md 4 | 採用 |
| I-026 | 2026-11-01 | **deploy はイメージ更新のみ**: manifest 検証 → migration（validate 0/10/1/75、10 は明示許可で migrate）→ Job → ingest → dashboard → ヘルス → ingress/IAP 不変の確認。mode=NORMAL 以外は既定で拒否。ingress/IAP/Scheduler/DB 起動状態には触れない | OPERATIONS_DESIGN §8 | 採用 |
| I-027 | 2026-11-01 | **apply は承認後の同一ジョブで plan→ガード→apply**（保存した plan だけを適用）。apply 後の status は手動/定期（reusable workflow だと WIF の workflow_ref が一致しないため自動連鎖しない） | OPERATIONS_DESIGN §8.2 | 採用（差異: 設計は『apply 後に自動 status』） |

| I-030 | 2026-11-02 | **ops を TypeScript へ移行**（web D-250・D-256。I-024 の『Python で実装』を置き換え）: `ops/src`（strict。外部 JSON・gcloud 出力・ops-state は zod で検査。GCS の generation は int64 文字列を bigint で保持）。GCS は JSON API を直接呼ぶ（google-cloud-storage 相当の依存を増やさない。トークンは gcloud）。終了コード・CLI 引数・ops-state の形・ビーコンの署名は旧版と互換（ビーコンは削除前の Python で生成したベクトル 8 件とバイト単位で一致）。**既知の問題を修正**: ① dry-run は何も書かない（旧版は前回の失敗記録を上書きしていた）② CAS の応答消失・412 は再読取りで自分の書込みの成立を確認（成立なら成功、他者なら中断）③ deploy の min_app_release の契約検査とロールバック判定（CONTRACTS §10。DB は戻さない）④ キャンセル時はリース解放と FAILED の記録を最優先（中断時は計測しない）⑤ deploy も start/stop と同じリースを取り、成功時に `ops-state.release` を記録。plan-guard は Terraform 用を移植（actions を判別できない変更は拒否に強化）。Pulumi 用のガードは L6 |
| I-031 | 2026-11-02 | **deploy 用 SA の権限追加（Terraform のコードのみ。apply は本人承認）**: `ops_state_deploy_state`（`state/` だけに objectUser）と `ops_state_deploy_history`（`history/` だけに objectCreator）。条件付き（I-032 で分割）。deploy がリースと release を書くため。ビーコン・署名鍵の権限は与えない（deploy はビーコンを書かない） |
| I-032 | 2026-11-02 | **L2 の独立レビュー（Opus・読取り専用）の反映**: 高 1・中 3・低 4。**高**: 中断の AbortSignal を GCS の全リクエストに渡していたため、中断後にリース解放と FAILED の記録が書けなかった → GCS にはリクエストごとのタイムアウトだけを渡す（中断の後も書ける。回帰試験: 実 GcsClient + signal を尊重する偽 fetch）。**中**: ① STOPPED の前進 deploy（db-migration のイメージ更新）でもロールバックの下限 `schema_min_app_release` を安全側に上げる（適用済みの版は migrate したときだけ上げる）② deploy は `--dry-run`/`--force` を受け付けない（終了コード 2）③ deploy の拒否（ops-state 無し・不正・STOPPED・ロールバック判定・他のリース）は何も書かない。**低**: history/ は objectCreator（削除できない）・state/ は objectUser に分割（I-031 を更新）／deploy は last_actual を上書きしない（deploy SA は Cloud SQL・Scheduler を読めない）／中断で止めた `jobs execute` は『中断』として扱う／GCS の 408 は結果不明。**要検証（G-OPS-11）**: `node … | tee` の形で、GitHub Actions のキャンセルのシグナルが node に届くか（旧版から同じ形。実 Actions で確認する） |
| I-033 | 2026-11-02 | **L2 再確認（Opus）の反映**: 中 1・低 4。中: deploy の migrate 中の中断で DB が進んでも下限が古いまま残る → db-migration のイメージを替える**前に**下限を上げて記録（migrate を実行しないまま失敗したら元に戻す）。低: 下限は常に max（下げない）／記録の形式不正はイメージを替える前に拒否／GCS の 200 の後の本文読取り失敗は結果不明／中断後は履歴を省いて本体の状態を優先。誤った STOPPED deploy で上がった下限を戻す手順は OPERATIONS.md（本人の操作） |
