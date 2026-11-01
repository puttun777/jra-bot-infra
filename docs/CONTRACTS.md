# CONTRACTS（インフラ側）

**正本: jra-bot-web `docs/CONTRACTS.md`。2026-11-01 の T5.0 で contract_version 0.4.15（web main 73f74c8）に同期した**（§5）。以下の §1〜§4 は 0.3.0-draft 時点の記述で、§5 の同期表が優先する。本ファイルは正本の各項目を**インフラでどう実現するか**と、**正本との差異（web 側での修正が必要なもの）**だけを書く。infra 側で契約を独自に変更しない（I-002）。同期作業 = T1.18（2026-10-22）。

## 1. 正本項目 → インフラでの実現
| 正本の項目（web CONTRACTS） | インフラでの実現 | 状態 |
|---|---|---|
| §1 成果物: `dashboard` / `bot` / `db-migration` / **`ingest`** / **`ml-train`** イメージ、`release-manifest.json`、エージェント配布物 | Artifact Registry（東京）に digest で参照。deploy は manifest のみを入力。エージェント配布物はインフラ管理外（web の Release） | 同期済み |
| §1 web→AR の push 権限は推測しない | 第5段階でユーザー確認の上、web リポジトリ用の WIF 主体を別途作成（`sa-gha-web-push`）。現時点では未作成・未付与 | 保留（ユーザー確認） |
| §2 環境変数: `DB_URL/DB_USER/DB_PASSWORD`、`DISCORD_WEBHOOK_URL`、`ALLOWED_USERS/ADMIN_USERS`、`IAP_AUDIENCE`、`OPS_MODE_SOURCE`、`MODE_BEACON_URL/PUBKEY`、`MODEL_STORE_URI`、`MODEL_SIGNING_KEY/VERIFY_PUBKEY`、`INGEST_TOKEN_*`、`TZ` | Terraform が Cloud Run/Jobs の環境変数・Secret 参照として設定。`OPS_MODE_SOURCE=gs://<prj>-ops-state/state/ops-state.json`、`MODE_BEACON_URL=https://storage.googleapis.com/<prj>-mode-beacon/beacon/mode.json` | 同期済み（名称は暫定のまま） |
| §3.1 ingest は dashboard と別サービス、IAP の外 | Cloud Run `ingest`（IAP なし、invoker=allUsers、アプリ認証）。STOPPED で ingress=internal | 同期済み |
| §3.2 `/internal/health` `/internal/ready`（infra から） | start の S8 で `sa-gha-ops` の Google ID トークンを付けて呼ぶ。dashboard は IAP のプログラム通過（`sa-gha-ops` に dashboard の `iap.httpsResourceAccessor`）、ingest はアプリが ID トークンの発行者・audience・SA メールを検証 | 同期済み（**web 側で検証仕様の明記が必要: 差異 D3**） |
| §3.3 エージェント認証（トークン+HMAC、ハッシュ保管、失効） | ペッパーは Secret Manager（`ingest-token-pepper`）。トークン本体はインフラに置かない（DB にハッシュ） | 同期済み |
| §3.6 / §7 STOPPED 時の送信抑止、503 + `X-Ops-Mode` | ingest がモード正本（GCS）を読み、NORMAL 以外は DB に触れず 503。STOPPED では ingress=internal でさらに遮断。エージェントはビーコンで判別 | 同期済み |
| §4 マイグレーション: デプロイごとに 1 回、起動時 migrate なし、「migrate 成功 → 更新」 | deploy ワークフロー: NORMAL 確認 → `db-migration`（migrate）→ ingest → Jobs 定義 → dashboard → status。start では `info/validate` のみ（保留中の版があれば失敗、明示時のみ migrate） | 同期済み（start 時の扱いを追加: 差異 D6） |
| §5 運用モード: 正本は DB 非依存ストア、start/stop 順序、`phase` 4 値、NORMAL のみ送信可 | GCS `ops-state.json`（CAS + リース + 版管理）。順序と失敗時の扱いは OPERATIONS_DESIGN §5・§6 | 同期済み（**フィールド名の整理が必要: 差異 D1**） |
| §5.1 ML 成果物・データセット・ml-train Job・署名鍵、infra の義務①〜④ | `model-store` バケット（非公開、datasets はライフサイクル 90 日、バージョニング）、IAM（ml-train: models 書込・datasets 読取、bot: models 読取・datasets 書込〔export-dataset〕）、`model-signing-key`（Secret、ml-train のみ）、`ml-train` Job（Scheduler は paused）、STOPPED では実行しない（Job 内でモード確認 + Scheduler 停止） | 同期済み |
| §7.2 ビーコン（静的 JSON、Ed25519、seq 単調、no-store、stop 最初/start 最後） | `mode-beacon` バケット（このオブジェクトのみ公開）。署名鍵は **Secret Manager**（`beacon-signing-key`, `sa-gha-ops` のみ） | 同期済み（**鍵の保管場所の記述が正本と異なる: 差異 D2**） |
| §7.5 infra の義務 1〜5 | 1: OPERATIONS_DESIGN §3、2: ingest のモード判定（DB 非依存）、3: STOPPED で ingest を ingress=internal、4: status にビーコン値・ingest 応答・エージェント最終接続、5: Terraform はバケットのみ管理 | 同期済み |

## 2. 正本との差異 D1〜D12（**解消済み**: web 0.4.0 で解消。web CONTRACTS §12。infra 側の追従は §5 の I-H1〜I-H9）
以下は当時の提案の記録。
| ID | 差異 | 提案（web CONTRACTS の修正内容） |
|---|---|---|
| **D1** | §3.2 の `/internal/ops/mode` は `desired: NORMAL\|STOPPED` と `phase` を併記、§5 は `phase` 4 値。用語が混在 | 状態のフィールドを `mode`（`NORMAL/STARTING/STOPPING/STOPPED` = 現在のフェーズ）と `desired`（`NORMAL/STOPPED` = 意図）に統一。ビーコンは `mode` を必須、`phase` は互換のため同値で併記（または削除） |
| **D2** | §7.2「秘密鍵は infra の CI シークレット」 | 「秘密鍵は **Secret Manager**（ops 用 SA のみ参照、GitHub に長期秘密を置かない）」に修正 |
| **D3** | §3.2 `/internal/*` の「機械用」の認証方式が未定義 | dashboard: IAP のプログラム通過（ops SA に IAP アクセス）+ アプリ側で IAP JWT のサブジェクトが ops SA であることを確認。ingest: Google ID トークン（発行者 accounts.google.com、audience=サービス URL、email=ops SA）をアプリが検証。いずれも**読み取り専用**の情報のみ返す |
| **D4** | アプリがモード正本を読む方法（キャッシュ、読めないときの扱い）が未定義 | `ModeProvider`: GCS の `ops-state.json` を 15 秒キャッシュ。読めない/スキーマ不一致は `UNKNOWN`（NORMAL 扱いしない）。bot/calendar-check は DB 接続前に確認し、NORMAL 以外は exit 0（再試行なし）。ingest は NORMAL 以外 503（UNKNOWN は `X-Ops-Mode` なし） |
| **D5** | エージェント最終接続を DB 停止中も status で見たい | ingest が `gs://<prj>-ops-state/agent/heartbeat-<tenant>.json` に**最終接続時刻だけ**を 5 分毎/変化時に書く（データ本文は書かない）。ingest SA にこのプレフィックスの書込のみ付与 |
| **D6** | start 時のマイグレーションの扱い | start は `flyway info/validate` のみ。保留版があれば start は失敗（`apply_pending_migrations=true` のときのみ migrate）。`db-migration` イメージに `--mode=info|validate|migrate` を求める |
| **D7** | `release-manifest.json` のスキーマ未定義 | §3 の案をそのまま採用してほしい |
| **D8** | DB 接続方式・プール上限が未定義 | プライベート IP への JDBC（TLS 必須）。IAM DB 認証は第2段階で検証（可能ならパスワード廃止）。プール上限: dashboard 5 / ingest 5 / bot 5 / calendar-check 2 / reconcile 2 / migrate 2 / ml-train 2（合計 ≤ 25）。DB ユーザーは用途別 |
| **D9** | Jobs の終了コード・リトライ | `max-retries=0`。終了コード: 0=正常（何もしない場合も 0）、75=一時失敗（DB 不達等、**Scheduler/Jobs 側では再試行しない**）、その他=失敗（通知）。SIGTERM（cancel）を受けたら現在サイクルを終えて checkpoint 保存（猶予時間は G-OPS-4） |
| **D10** | MySQL の版 | web D-015（9.7 暫定第一候補）を、**infra I-013（8.4 LTS を暫定基準、9.7 は第2段階の互換検証ゲート後に再判断）**に合わせて更新 |
| **D11** | STOPPED 中の dashboard | STOPPED では ingress=internal のため**到達不能**（STOPPED バナーは STARTING/STOPPING 中のみ表示される）。web FRONTEND_DESIGN §2.9 の注記と一致させる |
| **D12** | ml-train が DB に CANDIDATE を書く権限 | DB ユーザー `mltrain` は `ml_model` への INSERT と `ml_model` の自テナント SELECT のみ。データセットは GCS から読み、DB の他テーブルに触れない |

## 3. `release-manifest.json`（**[T5.0] 正本は web CONTRACTS §10 の schema_version 2。下の JSON は提案時の記録で使わない**）
```json
{
  "schema_version": 1,
  "release": "2026.11.0",
  "git_sha": "…",
  "built_at": "2026-11-01T00:00:00Z",
  "contract_version": "0.3.0",
  "agent_protocol": 1,
  "images": {
    "dashboard":    "asia-northeast1-docker.pkg.dev/<prj>/jra-bot/dashboard@sha256:…",
    "ingest":       "…/ingest@sha256:…",
    "bot":          "…/bot@sha256:…",
    "db-migration": "…/db-migration@sha256:…",
    "ml-train":     "…/ml-train@sha256:…"
  },
  "flyway": { "latest_version": "2", "baseline": "1" },
  "model_schema_versions": [1],
  "min_compatible_schema": "1",
  "notes": "…"
}
```
- インフラは `images.*` の digest 以外を参照しない（タグは使わない）。`min_compatible_schema` はロールバック可否の判定に使う。

## 4. infra が提供するもの（固有契約）
| 提供物 | 内容 |
|---|---|
| Terraform outputs | サービス URL、AR パス、Job 名、SA メール、バケット名（秘密なし） |
| `status` 出力 | Job Summary（Markdown 表）+ `status.json`（Artifact）: `{desired, mode, operation, actual:{db, dashboard, ingest, scheduler, executions, beacon, agent_last_seen}, mismatches[], contract_version}` |
| Secret 名 | `db-app-password`、`db-ingest-password`、`db-bot-password`、`db-migrate-password`、`db-mltrain-password`、`discord-webhook`、`discord-error-webhook`、`ingest-token-pepper`、`beacon-signing-key`、`model-signing-key`、`iap-oauth-client-secret`（第5段階で確定し web CONTRACTS §2 に反映） |
| 権限 | OPERATIONS_DESIGN §11、ARCHITECTURE §5 |


## 5. T5.0 同期表（web CONTRACTS 0.4.15 → infra。2026-11-01）
**この表が §1〜§4 より優先する。** infra の実装（第5段階）はこの表を入力にする。web の変更は web のセッション/PR で行い、infra はこの文書を追従させる。

### 5.1 引継ぎ項目 I-H1〜I-H9
| ID | web の契約 | infra の実現・更新箇所 | 状態 |
|---|---|---|---|
| I-H1 | モード **UNKNOWN の Job は exit 75**、確定した非 NORMAL は exit 0（§9.1） | OPERATIONS_DESIGN §2.4 を更新。status と通知は 75 を異常扱い | 文書同期済み |
| I-H2 | `db-migration --mode=validate` の終了コード **10 = 未適用あり**（0 / 1 / 75） | OPERATIONS_DESIGN §5 S4・S5 を更新（S5 は 10 のときだけ migrate 判定） | 文書同期済み |
| I-H3 | release-manifest **schema_version 2**: `required_schema_version`・`rollback.min_app_release`・`feature_schemas`/`feature_schema_hash`・`runtime`。`contract_version` のメジャー不一致は deploy 拒否 | deploy ワークフロー（T5.3）が JSON Schema（web `docs/schemas/release-manifest.v1.json`）で検証。プレビュー manifest（`kind`/`deployable`）は拒否 | 実装は T5.3 |
| I-H4 | ビーコンは `{schema_version, kid, mode, seq, updatedAt, validUntil?, sig}`（**`phase` 廃止**）。環境変数 `AGENT_HEARTBEAT_PREFIX`・`INTERNAL_ID_TOKEN_AUDIENCE`・`OPS_SA_EMAIL`・`DB_POOL_MAX`・`DISCORD_ERROR_WEBHOOK_URL`・`MODE_BEACON_PUBKEYS`（最大 2 本） | OPERATIONS_DESIGN §3 を更新。環境変数は §5.2 | 文書同期済み / Terraform は T5.2 |
| I-H5 | DB ユーザー `migrate`/`app`/`ingest`/`bot`/`mltrain`。Terraform はユーザー作成と Secret のみ、GRANT は web `R__grants.sql`。プール合計 24 | ARCHITECTURE §2・§3・§5 を更新 | 文書同期済み。G-DB-6 は実機検証 |
| I-H6 | calendar-check・reconcile・retention・export-dataset は **bot イメージ + `--task=`**（`bot-run` も同じ）。ml-train は `--tenant-id --dataset-id` | ARCHITECTURE §2 を更新（`backfill` は Job でなく ingest API） | 文書同期済み |
| I-H7 | cancel の猶予は **10 秒を前提**。bot-run は NORMAL 中の cancel で exit 75 | OPERATIONS_DESIGN G-OPS-4 を更新 | 文書同期済み / 実測は G-OPS-4 |
| I-H8 | `APP_ENV`（`local`/`prod`）を**全アプリに必須で渡す**。`REQUIRED_SCHEMA_VERSION` は渡さない（jar に焼き込み）。dashboard は `IAP_AUDIENCE`・`OPS_SA_EMAIL`、ingest は `INTERNAL_ID_TOKEN_AUDIENCE`・`OPS_SA_EMAIL` が無いと起動しない。本番の DB ユーザーは `app`/`ingest`/`bot` 以外だと起動拒否 | §5.2 の環境変数表 | Terraform は T5.2 |
| I-H9 | イメージ名は `asia-northeast1-docker.pkg.dev/<prj>/jra-bot/<name>@sha256:<64桁>` の **5 つ**（dashboard・ingest・bot・db-migration・ml-train）。ml-train が無い間は本番 manifest を生成できない | deploy はこの形式のみ受理（T5.3） | 実装は T5.3 |

### 5.2 環境変数（infra → app。Terraform / Secret Manager。web CONTRACTS §2 が正本）
| 対象 | 必須/任意 | 変数（運用値は未確定のものは **Terraform 変数にして既定値を置かない**） |
|---|---|---|
| 全アプリ | 必須 | `APP_ENV=prod`、`TZ=Asia/Tokyo`、`DB_URL`（`sslMode=VERIFY_CA`）、`DB_USER`/`DB_PASSWORD`（Secret `db-<用途>-password`）、`DB_POOL_MAX`、`OPS_MODE_SOURCE=gs://<prj>-ops-state/state/ops-state.json` |
| dashboard | 必須 | `IAP_AUDIENCE`、`OPS_SA_EMAIL`、`ALLOWED_USERS`/`ADMIN_USERS`（**空なら全拒否**）|
| ingest | 必須 | `INTERNAL_ID_TOKEN_AUDIENCE`、`OPS_SA_EMAIL`、`AGENT_HEARTBEAT_PREFIX=gs://<prj>-ops-state/agent/`、`INGEST_TOKEN_PEPPER`（Secret `ingest-token-pepper`）、`AGENT_KEK_KEYS`/`AGENT_KEK_ACTIVE_KID`（Secret `agent-kek`。本番必須、無いと起動失敗。**提案 P-1: 要承認**）|
| ingest | 任意 | `INGEST_ODDS_BELOW_PAR`（`quarantine` 既定）、`INGEST_STORE_COMBO_ODDS`（既定 false）、`INGEST_MAX_BODY_BYTES`/`INGEST_MAX_INFLATED_BYTES`。**`INGEST_ACCEPT_NORMALIZED_RECORDS` は本番で設定しない**（true だと起動失敗）|
| bot（全 `--task`） | 必須 | `MODEL_STORE_URI=gs://<prj>-model-store`（ML 有効時）|
| bot `--task=calendar-check` | 必須（**運用値未確定: 既定なし**）| `CALENDAR_WATCH_START_MINUTES`・`CALENDAR_PRESTART_MINUTES`・`CALENDAR_SETTLE_DEADLINE_MINUTES`・`CALENDAR_STALE_AFTER_MINUTES` |
| bot `--task=bot-run` | 必須（**運用値未確定: 既定なし**。案: lease 300 / heartbeat 60、poll 300/60/30、odds age 180）| `BOT_RUN_LEASE_SECONDS`・`BOT_RUN_HEARTBEAT_SECONDS`・`BOT_RUN_POLL_FAR/MID/NEAR_SECONDS`・`BOT_RUN_MAX_ODDS_AGE_SECONDS`・`BOT_RUN_MAX_RUNTIME_MINUTES`（≤840）・`BOT_RUN_STALE_CLAIM_SECONDS`・`BOT_RUN_MAX_CYCLE_FAILURES`・`BOT_RUN_SNAPSHOT_MINUTES`・`BOT_RUN_TIGHTEN_NEAR`・`BOT_RUN_SNAPSHOT_HISTORY_LIMIT`・`BOT_RUN_ML_MODEL_TYPE`（`off` で開始）・`BOT_RUN_DECISION_PROFILE=legacy_function_defaults` + CALENDAR_* と共通 |
| bot `--task=bot-run` | 任意 | `BOT_RUN_PRIORITY_MODE`・`BOT_RUN_HIT_RATE_MIN_EV`・`BOT_RUN_HIT_RATE_MIN_EV_SCHEDULE`、`DISCORD_WEBHOOK_URL`/`DISCORD_ERROR_WEBHOOK_URL`（Secret。形式 `https://discord.com/api/webhooks/<数字>/<トークン>` のみ）、`DISCORD_MENTION_USER_ID`（17〜20 桁）、ML 有効時 `MODEL_VERIFY_PUBKEY`（Ed25519 公開鍵の Base64。複数可）|
| ml-train | 必須 | `MODEL_STORE_URI`、`MODEL_SIGNING_KEY`（Secret `model-signing-key`）。引数 `--tenant-id --dataset-id` |
| 渡さない | — | `REQUIRED_SCHEMA_VERSION`・`RELEASE_ID`（イメージに焼き込み）|
**運用値（CALENDAR_*/BOT_RUN_*）の確定は T1.20/T1.21（本人の実環境確認）が前提**。確定まで Terraform 変数は**必須入力（既定なし）**にし、未入力の plan は失敗させる。

### 5.3 スキーマ版・GRANT・Job の実行契約
| 項目 | 内容（web が正本） | infra |
|---|---|---|
| スキーマ版 | 現在 **5**（V5〈承認済み・本番未適用〉: `race_evaluations` の UNIQUE、`race_timing_notice`）。アプリの `requiredSchemaVersion` は 5。DB が 5 未満だと各アプリは起動/ready 失敗（exit 1） | **deploy は migrate（`migrate` ユーザー）を先に実行してからアプリを更新**。V5 の本番適用は**ユーザー承認後**。ロールバックはアプリのみ（スキーマは戻さない）|
| GRANT | `R__grants.sql`（migrate 実行ごとに再適用）。bot は `race_timing_notice` に SELECT/INSERT のみ、app は SELECT のみ。`results`/`payouts` は ingest が SELECT/INSERT/UPDATE、bot は SELECT | Terraform は GRANT しない。deploy 後の smoke（status）で `db-migration --mode=validate` が 0 であることを確認 |
| 終了コード | 0 正常/対象なし・確定した非 NORMAL、**75 一時失敗（DB/GCS 不達・UNKNOWN。Jobs は再試行しない）**、2 引数/設定誤り、1 その他失敗 | Job は `max-retries=0`。Scheduler は再試行しない。1/2/75 は通知 |
| タイムアウト | bot-run 14 時間（≤`BOT_RUN_MAX_RUNTIME_MINUTES` 840 分。G-OPS-5 で上限確認）、他は 1 時間以内 | Job ごとに設定 |
| 通知の配送 | **自動再送しない（at-most-once）**。`SEND_UNKNOWN` は管理画面で確認 | infra は Webhook の Secret のみ。再送の自動化をしない |
| Discord Webhook | 形式制限（`discord.com` のみ）。本番では Secret Manager | `discord-webhook`・`discord-error-webhook` |

### 5.4 infra に関わる未解決（実機/本人判断。第5段階の前提）
G-OPS-1〜9（実 GCP）、G-DB-1/5/6/7、G-COST-1、F-7/F-8（JDK 25・MySQL 8.4/9.7・SIGTERM）、本番 release-manifest と署名鍵運用、V5 の本番適用の承認、P-1（`agent-kek`）の承認、運用値（CALENDAR_*/BOT_RUN_*）の確定、COMP-4（実データのクラウド投入）。**これらを満たす前に apply・課金リソース作成をしない**（CLAUDE.md の絶対ルール）。
