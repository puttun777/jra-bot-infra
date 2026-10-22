# CONTRACTS（インフラ側）

**正本: jra-bot-web `docs/CONTRACTS.md`（contract_version 0.3.0-draft、2026-10-22 時点の main fa5e59c で確認）**。本ファイルは正本の各項目を**インフラでどう実現するか**と、**正本との差異（web 側での修正が必要なもの）**だけを書く。infra 側で契約を独自に変更しない（I-002）。同期作業 = T1.18（2026-10-22）。

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

## 2. 正本との差異（web 側での修正が必要 → Stage 1-D② へ引継ぎ）
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

## 3. `release-manifest.json`（提案, schema_version 1）
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
