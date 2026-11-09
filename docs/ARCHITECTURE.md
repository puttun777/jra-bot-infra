# ARCHITECTURE（インフラ: GCP 採用設計・第1段階確定版）

**T5.0 同期（2026-11-01）**: web CONTRACTS 0.4.15 に合わせて Jobs・DB ユーザー・接続プール・環境変数・スキーマ版を更新した（下の `[T5.0]` 印）。差分の一覧と根拠は `CONTRACTS.md` §5。

更新: 2026-10-22（T1.7/T1.8 設計確定）。**設計上の採用であり、GCP の契約・課金リソース作成の承認ではない**。費用は `CLOUD_COSTS.md`、運用は `OPERATIONS_DESIGN.md`、契約の正本は jra-bot-web `docs/CONTRACTS.md`。

## 1. 全体構成（単一プロジェクト・東京 asia-northeast1）
```
                 ┌──────────────── GitHub Actions（OIDC → Workload Identity Federation）────────────────┐
                 │ ops-start / ops-stop / ops-status / deploy / terraform-plan|apply / ml-train-run       │
                 └───────┬───────────────┬──────────────────┬───────────────────────────────┬───────────┘
                         │ state/beacon  │ ingress/patch     │ deploy(digest)                │ pause/resume
    ブラウザ(許可2名) ──IAP──▶ Cloud Run: dashboard (min=0)      Artifact Registry          Cloud Scheduler
                                  │                                                       │ (calendar-check / reconcile
  Windows エージェント ──HTTPS(トークン+HMAC)──▶ Cloud Run: ingest (min=0, IAPなし)              │  / retention / ml-train[paused])
        │  └─GET(公開・署名付き)──▶ GCS: mode-beacon/beacon/mode.json                          ▼
        │                                                          Cloud Run Jobs: calendar-check ─▶ bot-run
        │                          Direct VPC egress (プライベート範囲のみ)      reconcile / retention / db-migration
        │                                    ▼                              export-dataset / ml-train(Python)
        │                       Cloud SQL for MySQL (Enterprise, db-f1-micro〔I-041〕, プライベートIPのみ)
        │                       GCS: ops-state(非公開・版管理) / model-store(非公開) / tfstate(非公開)
        │                       Secret Manager / Cloud Logging / Cloud Monitoring(最小)
```
## 2. コンポーネント設定（設計値）
| コンポーネント | 設定 | 理由・費用への影響 |
|---|---|---|
| **dashboard**（Cloud Run service） | min=0、**max=2**、concurrency=40、1 vCPU/1 GiB、**リクエスト課金**、直接 IAP、ingress は ops 管理 | スケールゼロ。max で暴走費用を抑える |
| **ingest**（Cloud Run service） | min=0、**max=2**、concurrency=20、1 vCPU/1 GiB、リクエスト課金、IAP なし（アプリ認証: トークン+HMAC）、invoker は allUsers（認証はアプリ層） | 機械クライアントのため IAP 外（web D-020）。STOPPED は ingress=internal |
| **bot**（Cloud Run Job, **[T5.0] 同一イメージで `--task=bot-run|calendar-check|reconcile|retention|export-dataset|backtest`**。`backfill` は Job ではなく ingest の API〔バックフィル要求〕。ml-train の引数は `--tenant-id --dataset-id`〔I-H6〕） | bot-run: 1 vCPU/2 GiB、`max-retries=0`、タスクタイムアウト 14h（**G-OPS-5 で上限確認**）、並列 1。calendar-check: 0.5 vCPU/1 GiB、タイムアウト 5 分 | 必要時間帯のみ実行 |
| **db-migration**（Job） | Flyway。`migrate` は deploy（NORMAL）時のみ、`info/validate` は start でも使用 | 起動時 migrate はしない（CONTRACTS §4） |
| **ml-train**（Job, Python イメージ） | 2 vCPU/4 GiB、タイムアウト 1h、手動/Scheduler（初期 paused） | 常駐しない |
| **Cloud SQL for MySQL** | **Enterprise エディション（明示指定）**、**db-f1-micro**（共有コア 0.6 GB。2026-11-09 に db-g1-small から変更: I-041。G-DB-1・P-3 で不足なら戻す）、SSD 10 GB、**MySQL 8.4 LTS を暫定基準**（9.7 は第2段階の互換検証ゲート後に再判断）（自動拡張あり・上限 50 GB）、**プライベート IP のみ（公開 IP なし）**、自動バックアップ毎日・保持 7、PITR は初期オフ、HA なし、メンテナンス枠 = 火曜 03:00 JST 付近（開催の少ない曜日。G-OPS-3 で停止中の挙動を検証）、`deletion_protection=true` | §3 |
| ネットワーク | 専用 VPC + サブネット（Direct VPC egress 用）、Cloud SQL はプライベートサービスアクセス。**Serverless VPC Access コネクタ・Cloud NAT・ロードバランサは使わない**（固定費ゼロ）。Direct VPC egress は「プライベート範囲のみ」→ Discord 等のインターネット宛はそのまま外部へ | VPC 固定費なし（要検証: G-NET-1） |
| Cloud Scheduler | calendar-check（毎日 06:00〜19:00 の 15 分毎）、reconcile（月曜 14:30 以降の数回）、retention（月 1 回）、ml-train（paused） | ジョブ数 4（無料枠 3 を超える 1 ジョブ分 $0.10/月） |
| GCS | `ops-state`（非公開・バージョニング）、`mode-beacon`（ビーコン 1 オブジェクトのみ公開読取）、`model-store`（非公開、datasets はライフサイクル 90 日）、`tfstate`（非公開・バージョニング） | 合計 1 GB 未満 |
| Artifact Registry | 東京の Docker リポジトリ 1 つ、**クリーンアップポリシー（各イメージ最新 3 版 + 稼働中 digest を保持）** | 数 GB に抑える |
| Secret Manager | `db-app-password` 等の DB ユーザー別パスワード、`discord-webhook`、`discord-error-webhook`、`ingest-token-pepper`、`beacon-signing-key`、`model-signing-key`、`iap-oauth-client-secret`（カスタム OAuth クライアント使用時） | 無料枠 6 版を少し超える程度 |
| Logging / Monitoring | 構造化ログ（JSON）、ログ保持は既定（30 日）、アラートは最小限（§9） | 50 GiB/月/プロジェクトまで無料 |

## 3. Cloud SQL の選定（T1.7）
| 項目 | 確認結果 | 確度 |
|---|---|---|
| エディション | **Enterprise** を採用。Enterprise Plus は高性能・高可用（データキャッシュ、メンテナンスのほぼ無停止など）だが高額で、**共有コア（db-f1-micro / db-g1-small）は Enterprise のみ**。**MySQL 8.4 / 9.7 はエディション未指定だと Enterprise Plus が既定** → **必ず Enterprise を明示** | 公式ドキュメントの検索抜粋（choose-edition, create-instance） |
| MySQL 版 | Cloud SQL では 8.0 / 8.4 / 9.7 が選択可（9.7 GA は 2026-08-13）。Flyway の公式「検証済み版」は 5.7 / 8.0 / 9.4（2025-01 時点の記載）で **8.4・9.7 は明記なし**。Connector/J 9.7.0（Boot BOM）、Doma の MySQL 方言は版非依存の想定 → **互換性が確認できていないため 8.4 LTS を暫定基準**（ユーザー方針）。9.7 は第2段階で Testcontainers（Flyway 13.11.1 + Connector/J 9.7.0 + Doma 3.14.1）で検証し、通れば再判断（web D-015 の更新が必要: 引継ぎ） | 検索抜粋 + VERSIONS |
| マシン | **2026-11-09 変更: 既定を db-f1-micro（共有 vCPU・0.6 GB）にする**（本人が費用最小化の案 1 を選択: web D-278・HOSTING_OPTIONS）。当初は不採用としていた理由（MySQL 8.4 のメモリ・接続数の不足の恐れ）は残るため、**本番で使う前に G-DB-1（作成画面で選べるか・`max_connections`）と P-3（本人承認後の短時間の負荷試験）で確かめる**。不足なら設定 `dbTier`（Terraform は `db_tier`）を db-g1-small に戻す（コードの変更は不要）。旧: **db-g1-small**（共有 vCPU、1.7 GB、ストレージ上限約 3 TB、SLA 対象外）を第一候補。**db-f1-micro（0.6 GB）は不採用**（MySQL 8.4 のメモリ要件・接続数で不足の恐れ。検証なしに採用しない）。8.4/9.7 での共有コア提供可否は**未確認**（G-DB-1）。不可の場合の代替は `db-custom-1-3840`（1 vCPU/3.75 GB, 推定 +¥4,800/月） | 料金ページ（Iowa 単価）+ 検索 |
| 接続数 | db-g1-small の `max_connections` 既定は 1,000 との第三者記載（**未確認**）。**既定の db-f1-micro の値も未確認**（G-DB-1。合計 25 を受けられなければプール上限を下げるか db-g1-small に戻す）。**[T5.0] アプリの接続プール合計は 25（≤ 25。2026-11-06 に backtest 1 を追加: I-038）**（web CONTRACTS §8.3: dashboard 3×最大 2 インスタンス、ingest 3×2、bot-run 4、calendar-check/reconcile/retention 各 1、export-dataset 2、db-migration 2、ml-train 1。`DB_POOL_MAX` で上書き可。インスタンス数を増やしたら合計を再計算）→ 余裕あり | 第三者 |
| 性能 | 共有 CPU のバースト。想定負荷（オッズ書込: 1 サイクル数十行、ダッシュボード 2 名）では十分の見込み。第2段階で負荷試験（G-DB-4） | 推定 |
| ストレージ | SSD（HDD は月数百円安いが書込性能が低い）。**10 GB から開始**（2026-11-09。旧 20 GB。データは 3 年で 5〜10 GB の見込み）。**ディスクは縮小できない**: 自動拡張した後や、既に大きく作ったインスタンスには小さい値を適用しない（IaC は作成後の大きさの差分を無視する: I-041）・自動拡張は上限 50 GB（費用の暴走防止） | 料金ページ |
| 停止・復帰 | `activation-policy=NEVER` で停止（**手動で開始するまで停止のまま**: 公式記述の抜粋）、`ALWAYS` で起動。**停止中もストレージと IP の課金は継続**（公開 IP を持たない設計。プライベート IP の課金有無は G-OPS-2） | 公式抜粋 |
| メンテナンス | 停止中のインスタンスがメンテナンスで起動するかは**公式記述を確認できず**（G-OPS-3）。起動中のメンテナンスは短時間の再起動を伴う → 開催日の監視時間帯を避けた枠に設定 | 未確認 |
| バックアップ・復旧 | 自動バックアップ（毎日・7 世代）＋ 重要操作前（migration、stop 時の任意）にオンデマンド。PITR はバイナリログで容量と書込負荷が増えるため初期オフ（データ損失許容 = 最大 1 日。bot の取込は JV-Link から再取得可能＝JVLINK_DESIGN §6）。リストアは別インスタンスへの復元で手順化（第5段階） | 設計 |
| HA | 初期は不要（要件）。将来は Enterprise の HA（費用約 2 倍）を検討 | — |

## 4. 起動・停止・状態確認
`OPERATIONS_DESIGN.md` に確定設計（4 モード、GCS 正本、CAS とリース、署名付きビーコン、start/stop/status の各ステップと失敗時の扱い、影響マトリクス、apply 前ガード、監視、手動復旧、検証ゲート）。

## 5. セキュリティ境界
| 境界 | 設計 |
|---|---|
| 人（2 名） | dashboard は**直接 IAP**。許可は `roles/iap.httpsResourceAccessor` を**個人のメール**に付与（Terraform 管理）。**初期は誰にも付与しない＝全拒否**。アプリ側でも IAP の JWT を検証し、`app_user`（tenant・role）未登録は 403（web FRONTEND_DESIGN §4.4）。管理操作は `ROLE_ADMIN` |
| 機械: エージェント | ingest のアプリ認証（トークンはハッシュ保管、HMAC 署名、リプレイ防止、失効）。IAP の外（web CONTRACTS §3.3）。STOPPED は ingress=internal でさらに遮断 |
| 機械: GitHub Actions | OIDC → WIF（リポジトリ・ブランチ・ワークフローで条件付け）。**長期 SA キーなし**。操作ごとに SA を分離（OPERATIONS_DESIGN §11） |
| 機械: ランタイム | サービス/ジョブごとの SA。DB ユーザーも用途別（**[T5.0] 名前は `migrate` / `app` / `ingest` / `bot` / `mltrain`**〔web CONTRACTS §8.2〕。**Terraform はユーザーの作成とパスワードの Secret 化だけを行い、GRANT は web の Flyway `R__grants.sql` が `REVOKE ALL` → 最小限の GRANT で定義する**。`migrate` には `GRANT ALL ON <schema>.* WITH GRANT OPTION` まで infra が付ける。G-DB-6 で Cloud SQL のユーザー既定権限と GRANT 可能範囲を検証。`mltrain` は `ml_model` の SELECT/INSERT のみ）。Cloud SQL の管理権限はランタイムに与えない（DB を起動できない） |
| ネットワーク | Cloud SQL はプライベート IP のみ、公開 IP なし、Cloud SQL Auth Proxy 不要（Direct VPC egress 経由の JDBC + TLS 強制）。IAM DB 認証は第2段階で検証（G-DB-5）し、可能ならパスワードを廃止 |
| 秘密 | Secret Manager のみ。GitHub のシークレットには長期の秘密を置かない（WIF の設定値=非秘密のみ） |
| データ分離 | `tenant_id`（web D-023/D-039）。インフラ側は DB をテナントで分けない（共有スキーマ）。モデル/データセットのバケットはパスを `/{tenant_id}/` で分け、IAM はバケット単位（将来必要ならテナント別バケット） |
| STOPPED 時 | 認証設定は**変更しない**（IAP・IAM・許可リスト・トークン）。ingress を内部限定にするだけ |
| 公開物 | ビーコン（署名付き・秘密なし）のみ公開。それ以外のバケットは均一アクセス + 公開アクセス防止 |

## 6. 組織（Organization）なしプロジェクトでの直接 IAP
- 公式ドキュメント（検索抜粋）: 組織に属さないプロジェクトでも Cloud Run の直接 IAP は利用可能。ただし既定の Google 管理 OAuth クライアントは組織内ユーザー向けのため、**個人の Google アカウント（組織外）を通すにはカスタム OAuth クライアントが必要**。**組織なしでは Terraform から OAuth クライアントをプログラムで作れない** → **初期設定の手作業**（Cloud Console で OAuth 同意画面〔外部〕とクライアントを作成し、ID/シークレットを Secret Manager へ登録、Terraform はそれを参照）。
- 同意画面の公開ステータス（テスト/本番）、テストユーザー数の上限、再ログイン頻度は **G-OPS-8** で確認。2 名利用ならテストユーザー登録で足りる見込み。
- 必要ロール（作業者）: IAP Settings Admin、OAuth Config Editor（ユーザー自身が実施）。
- 代替（不可だった場合）: ①Google Workspace / Cloud Identity Free で組織を作る（Cloud Identity Free は無料枠あり。**ユーザー判断**）、②Identity Platform + アプリ認証（MAU 課金の可能性、公開時向け）。

## 7. デプロイとリリース
- 入力は web の `release-manifest.json`（イメージ digest、Flyway 版、契約版）のみ（CONTRACTS §1）。web のレジストリ・権限は**推測しない**（web CI から Artifact Registry への push 権限は第5段階でユーザー確認後に WIF で付与）。
- 順序: mode=NORMAL を確認 → db-migration（migrate）→ ingest → bot/Jobs 定義 → dashboard → status。STOPPED 中は既定で拒否（OPERATIONS_DESIGN §8.1）。
- ロールバック: 直前の manifest で再デプロイ（スキーマは expand/contract で後方互換）。

## 8. 将来の拡張（初期は導入しない）
| 規模 | 変更 |
|---|---|
| 100 人 | DB を `db-custom-1-3840`、dashboard max 5、Monitoring アラート拡充 |
| 1,000 人 | DB 2 vCPU/7.5 GB（必要なら HA）、read replica、外部 HTTPS LB + Cloud Armor（固定費増）、Identity Platform。**一般公開は規約上 JRADB が前提**（web DATA_SOURCE_COMPLIANCE #8） |

## 9. 代替案の記録（GCP で重大な問題が出た場合）
| 問題 | 代替 |
|---|---|
| 共有コアが MySQL 8.4 で使えない | `db-custom-1-3840`（+約 ¥4,800/月）または MySQL 8.0（2026 年時点でサポート期限に注意） |
| 停止中の Cloud SQL が勝手に起動する | 定期 stop（修復）の頻度を上げる。それでも問題なら AWS A1 案（CLOUD_COSTS §5.5）を再評価 |
| 直接 IAP が組織なしで運用困難 | §6 の代替 |
| Cloud Run Jobs の最大実行時間が不足 | bot-run を分割実行（checkpoint 再開） |
