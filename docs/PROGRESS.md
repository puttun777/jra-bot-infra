# PROGRESS（jra-bot-infra）
最終更新: 2026-11-02（L2: ops を TypeScript へ。旧: 2026-11-01 第5段階のコード・workflow・Runbook）

## 2026-11-02 L2: ops を TypeScript へ移行（ブランチ claude/lang-l2-ops-ts。web の言語移行 D-250。I-030・I-031）
- **ops/src**（TypeScript strict）: `state`（zod）・`engine`（start/stop）・`deploy`（リース・ロールバック判定・release の記録）・`status`・`plan-guard`（Terraform 用の移植）・`beacon`（Ed25519）・`gcp/gcloud`・`gcp/gcs`（JSON API・generation は bigint）・`cli`（終了コード 0/1/2/3 は旧版と同じ。中断も 1）。旧 `ops/jrabot_ops`・`ops/tests`（Python）は削除。
- **既知の問題の修正**: dry-run が書かない／CAS 応答消失・412 は再読取りで成立確認／min_app_release とロールバック判定（CONTRACTS §10）／キャンセル時のリース解放と FAILED 記録を最優先／deploy もリースを取る。
- **互換性の証拠**: 削除前の Python 実装でビーコンのベクトル 8 件を生成（`ops/test/vectors/beacon_vectors.json`。生成元コミット e21e9e4）し、TS 版の出力バイト列・正準形・署名が完全一致（2^53 を超える seq は丸めずに拒否）。
- **workflow**: `.github/actions/setup-ops`（setup-node v7.1.0 = SHA 固定、`npm ci --ignore-scripts`、tsc）。全 workflow の `python -m jrabot_ops.cli` を `node ../build/ops/src/cli.js` に、`python3 -c`（JSON 生成）を `jq -n` に置換。deploy は `--actor/--run-id/--run-url` を渡す（リースのため）。
- **Terraform（コードのみ）**: `ops_state_deploy_write`（deploy SA に ops-state の state/・history/ だけ書込み。I-031。apply は本人承認）。
- **検証（ローカル、Node 24.22.2）**: `npm run lint`・tsc（strict）成功、ops 試験 **104 件成功**（旧 Python 77 件の全ケース + 既知問題の回帰 + 互換ベクトル）。修正点の変異試験（dry-run・412・再読取り・min_app_release・中断時の計測）で該当試験が失敗することを確認。`terraform fmt -check` 成功。**未実施**: `terraform init/validate/test`（registry.terraform.io がこのセッションから 403。CI で確認）、実 GCP（gcloud の出力形式・GCS の実応答: G-OPS-1〜10）、GitHub 上の workflow 実行。

## 2026-11-01 第5段階（T5.1〜T5.6）のコード化
- **terraform/**: 基盤（API・VPC・Cloud SQL〔停止側の初期値〕・バケット 3・Secret〔値なし〕・Artifact Registry・SA・カスタムロール・WIF・Cloud Run service/Jobs・Scheduler〔paused〕・監視/予算）。`ignore_changes` でモード制御属性とイメージを Terraform から外す。
- **ops/**: `engine`（start/stop ステップ・リース・CAS）、`state`、`beacon`（Ed25519）、`status`、`plan_guard`、`deploy`、`gcloud_adapter`、`cli`。単体試験 76 件。
- **.github/**: `ci.yml`（ops 試験 + fmt/validate/test + `ci-gate`）、`ops-start/stop/status`、`deploy`、`terraform-plan/apply`、composite 2 つ。排他は `concurrency: ops-prod`。
- **docs/OPERATIONS.md**（Runbook・初期導入順序・本人の作業 U1〜U8・ロールバック・復元・鍵更新）。
- **検証したこと**: `terraform fmt -check`・`validate`（実プロバイダ 8.9.0 のスキーマ）・`terraform test`（mock 16 件）、`python -m unittest`（70 件）、workflow の YAML 構文。
- **検証していないこと**: 実 GCP への `plan`（認証が必要）、GitHub 上の workflow 実行、検証ゲート G-OPS-1〜9、`gcloud` 出力の形式（実 GCP の応答）。**mock の成功は実 plan の成功ではない。**
- **独立レビュー（Opus、読み取り専用、91c3765）**: 高 4・中 8・低 5。反映: H1 全 workflow に `shell: bash`（pipefail）+ 失敗時の Discord 通知 / H2 gcloud 等の予期しない失敗も FAILED として記録しリースを必ず解放 / H3 `run.jobs.run` を外し db-migration の Job にだけ `jobsExecutorWithOverrides` / H4 terraform の WIF を『main の terraform-plan/apply.yml』に束縛 / M1 修復モードでもビーコンを mode に合わせて再署名 / M2 DB 停止の直前に毎回、実行中 Job と ingress を測る / M3 実行中 Job は完了時刻の無いものを数える / M4 終了コードの取得に fallback（取れなければ 1 = fail closed。実機確認は G-OPS-10）/ M5 plan_guard に（遷移中の apply 拒否・iam_policy・IAP 許可の主体種別・invoker_iam_disabled・作成時の ingress/paused）/ M6 sa-gha-tf の actAs・IAP サービスエージェントの invoker / M7 初回 apply の順序（DB は起動して作られる → 直ちに ops-stop、Secret は 2 段階）を文書訂正 / M8 status は IAP の無効を常に ❌ / 低: status は署名鍵を読まない、job 名 `ci gate`。**未対応（記録）**: dry_run が operation を上書きする、deploy の validate 失敗時に db-migration のイメージが新しいまま残る（手順で回避）、ビーコン seq と ops-state.seq の比較定義、ingest の外部到達判定（G-OPS-1）、`rollback.min_app_release` の検査。
- **再レビュー（Opus、e04cfea）**: 中 4・低 3。反映: plan の要約を pipefail で落とさない / 停止の S10 が自分で drain・close・外部到達確認をやり直す（再実行だけで回復できる）/ 初期導入の手順（DB は起動して作られる → 手元で `activation-policy=NEVER`。ops-stop は service/Scheduler が出来てから）/ ビーコンに kid を記録し、鍵更新後は mode が同じでも再署名 / deploy が検証に失敗したら db-migration のイメージを前の版に戻す / 重複した IAM 付与を整理 / SIGTERM・Ctrl-C でもリース解放と FAILED の記録 / 終了コード fallback は今回できた execution だけ / 未確定の IAM 主体は拒否。単体試験 76 件。未対応（記録）: dry_run が operation を上書きする、GCS の CAS で応答が失われた再試行が 412 になる件（G-OPS-6）、`rollback.min_app_release` の検査。
- **本人の作業**: `docs/OPERATIONS.md` §0。承認が要るもの: apply・課金リソース作成・V5 の本番適用・P-1。

## （以前の記録）

## 2026-11-01 T5.0 完了（文書のみ。ブランチ claude/jra-bot-replace-continue-l1lk71）
- `CONTRACTS.md` §5（同期表: I-H1〜I-H9、環境変数、スキーマ版 5・GRANT・終了コード）、`ARCHITECTURE.md`（Jobs・DB ユーザー・プール 24）、`OPERATIONS_DESIGN.md`（UNKNOWN=75、validate=10、ビーコンの `kid`・`phase` 廃止、cancel 猶予 10 秒）を更新。DECISIONS I-023、PLAN T5.0 完了。
- Terraform・ワークフロー・課金リソースの変更なし（`terraform` 未実行）。第5段階の実装（T5.1〜T5.6）は未着手。
- **次**: T5.1（Terraform 基盤のコード。`plan` まで。apply はユーザー承認後）。実 GCP の検証ゲートと、運用値・V5 本番適用・P-1 の承認が前提の項目は CONTRACTS §5.4。

## （以前の記録）
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
