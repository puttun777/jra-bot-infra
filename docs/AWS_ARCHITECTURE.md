# AWS 構成（GCP からの移行先。2026-11-13。I-042〜I-047・web D-280〜D-287）

**状態: 定義・試験まで（AWS には何も作っていない）**。`pulumi up`・課金リソースの作成・実データの移行は本人の承認後（CLAUDE.md 絶対ルール 3）。
運用の手順は `AWS_OPERATIONS.md`、費用は `CLOUD_COSTS.md` §12、アプリ側の契約は web の `docs/CONTRACTS.md`（0.4.19）。

## 1. 方針と全体像
利用者は本人 1 名・私的利用（web REQUIREMENTS §0）。**普段は EC2 を止めておき、開催日と、本人が見たいときだけ起動する**（月 100 時間前後）。
固定費を作る NAT Gateway・ALB・RDS・Elastic IP は使わない。

```
[本人のスマホ/PC] ──HTTPS──> Route 53 (A レコード: 起動のたびに Lambda が更新)
        │                         │
        │                  EC2 t4g.small（東京・パブリックサブネット・SG は 443/80 だけ）
        │                   ├ Caddy（Let's Encrypt。/internal は 404、/v1/agent/* → ingest、他 → oauth2-proxy）
        │                   ├ oauth2-proxy（Cognito の OIDC。本人のメールだけ。ID トークンを Authorization で dashboard へ）
        │                   ├ dashboard / ingest（Kotlin。127.0.0.1 と内部ネットワークだけ）
        │                   ├ MySQL 8.4（公開しない。データはデータ用 EBS /data）
        │                   ├ bot-run / bot のタスク / batch / ml-train / db-migration（その都度起動するコンテナ）
        │                   └ jrabot-host（運用エージェント。systemd の 1 分ごとの tick・起動・排出・バックアップ・deploy）
        │
[GitHub Actions（infra。手動実行・スマホ可）] ──OIDC──> IAM ロール（lambda:InvokeFunction 等だけ）
        └──> Lambda「制御」（VPC に接続しない） <── EventBridge Scheduler（5 分ごと）
                 ├ S3 ops-state（運用状態の正本・ホストの報告・開催予定。条件付き書込みで CAS）
                 ├ EC2 の起動・停止 / Route 53 の更新 / ビーコンの署名（S3 beacon。公開はこの 1 オブジェクトだけ）
                 └ Discord 通知（失敗・停止し忘れ）
[Windows 取得エージェント] ── ビーコン（S3 の公開オブジェクト・Ed25519 署名）を読む → NORMAL のときだけ https://<サイト>/v1/agent/* へ送る
```

## 2. 採用した AWS サービスと理由
| 用途 | 採用 | 理由・代替案 |
|---|---|---|
| 計算 | EC2 **t4g.small**（arm64・2 vCPU・2 GiB）+ swap 1 GiB、`cpuCredits=unlimited` | 実測（web HOSTING_OPTIONS・2026-11-13）で開催日の同時稼働のピーク約 1.4 GiB（MySQL 177・dashboard 212・ingest 212・bot-run 203 MiB + OS）。t4g.micro（1 GiB）は不足。t3.small（x86）は 26% 高い。arm64 は CI でネイティブにビルド・起動を確認（web images-arm64）。重い処理（batch・ML）は開催日と同時に動かさない（§5） |
| DB | EC2 上の MySQL 8.4（コンテナ）+ **データ用 EBS gp3 16 GB**（`protect`・`retainOnDelete`） | RDS は停止中もストレージ・バックアップ課金があり、7 日で自動起動する。Aurora Serverless v2 は最低 ACU の費用。アプリの MySQL・Doma・Flyway はそのまま |
| 状態・成果物 | S3（ops-state・beacon・models・backups） | GCS の置換え。運用状態は条件付き書込み（If-Match/If-None-Match）で CAS |
| 起動・停止・状態 | Lambda（Node 24・arm64・**VPC なし**）+ EventBridge Scheduler（5 分ごと） | Cloud Scheduler・Cloud Run Jobs（ops）の置換え。VPC に入れないので NAT 不要 |
| 本人の認証 | Cognito ユーザープール（**Lite**・管理者だけが作成・MFA 必須）+ oauth2-proxy | IAP の置換え。ALB（月 $16〜）を使わない。アプリは ID トークンの署名を JWKS で検証（web cloud-aws `CognitoIdTokenVerifier`） |
| HTTPS・DNS | Caddy（Let's Encrypt の HTTP-01・自動更新）+ Route 53 のホストゾーン | 証明書は EBS（/data/caddy）に残す（起動のたびに取り直さない: 発行の回数制限）。IP は起動のたびに変わるので Lambda が A レコードを UPSERT（TTL 60） |
| 秘密 | SSM Parameter Store の SecureString（標準・AWS 管理キー） | Secret Manager の置換え。Secrets Manager は 1 件 $0.40/月のため不採用 |
| イメージ | ECR（`IMMUTABLE`・最新 6 世代） | Artifact Registry の置換え |
| 管理の経路 | SSM Run Command（GitHub Actions から）・SSM Session Manager | SSH・鍵・22 番を使わない |
| デプロイ | GitHub Actions の OIDC → IAM ロール | 長期キーを持たない |
| ログ | コンテナは json-file（10 MB×3）、Lambda は CloudWatch Logs（14 日） | Cloud Logging の置換え。ホストのログを CloudWatch に送らない（費用） |
| 予算 | AWS Budgets（通知だけ。**強制停止ではない**） | 停止し忘れの安全網は制御の `maxRunningHours`（§4）とホストの稼働の上限（§5） |
| 制御の監視 | CloudWatch のアラーム 2 個（Lambda のエラーが 1 時間に 3 回以上・定期実行が 1 時間来ない）→ SNS → メール | 制御が動かないと自動停止も通知も止まるため。購読の確認は本人（U12） |
| バックアップ | mysqldump（整合）→ S3（SHA-256 確認・バージョニング・保持 35 日）+ EBS スナップショット（DLM・週 1・2 世代） | Cloud SQL の自動バックアップの置換え |

不採用: NAT Gateway・ALB・RDS・Elastic IP（停止中も課金）・CloudFront・Secrets Manager・CloudWatch Agent・ECS/Fargate（常駐の費用）・Python。

## 3. 運用モードと起動目的（hold）
- 運用状態（web CONTRACTS §7 の ops-state）は S3 `state/ops-state.json`。GCP と同じ `mode`（STOPPED・STARTING・NORMAL・STOPPING）に、AWS の節 `aws`（起動目的の一覧・停止の記録など）と、アプリに渡す **`workloads {raceday, batch}`**（web D-282）を足した。
- **起動目的（hold）**: `VIEW`（閲覧）・`RACEDAY`（開催日）・`BATCH`（重い処理）・`MAINTENANCE`（deploy）。それぞれ期限を持つ。hold が 1 つでもあれば起動し、全部無くなれば停止する。
  - `VIEW`: 本人の手動。同じ要求の再実行は「今から N 分」に延長（短くしない）。`view-end` は、その実行より後に延長された VIEW は外さない（古い停止の要求で、新しい閲覧を止めない）。
  - `RACEDAY`（同時に 3 日まで。発走時刻がその日〔JST〕の外なら既定の時刻を使うので、窓は 1 日 + 前後の余裕に収まる）: アプリが JRA の開催予定から作る計画（`--task=calendar-plan` → S3 `control/calendar-plan.json`。web D-283）と手動の登録から、**最初の発走の 240 分前〜最後の発走の 150 分後**に自動で作る（設定 `racedayLeadMinutes`・`racedayTailMinutes`）。ホストが「その日の処理が終わった」と報告したら外す（終了を待たずに停止しない・終わったら早めに止める）。
  - `BATCH`: 開催日の処理中は拒否（開催日が優先・メモリ）。
- **workloads**: `raceday` は RACEDAY の hold があり NORMAL/STARTING のときだけ true、`batch` は BATCH の hold があり RACEDAY が無いときだけ true。アプリの bot の Job は `OPS_WORKLOAD_GATE=required` で、**raceday=false なら bot-run・通知のタスクを起動しない**（閲覧だけの起動で Discord に通知しない）。
- **ビーコン**（Windows エージェント向け。web CONTRACTS §7.2）: NORMAL は「RACEDAY で、ホストが ingest の準備完了を報告している」ときだけ。閲覧だけの起動ではエージェントに送らせない。
- 停止の判断は制御だけが行い、EC2 の停止（電源）とアプリの STOPPED を混同しない: 制御が STOPPING にする → ホストが排出（受付停止 → 実行中の処理の終了 → バックアップ → MySQL の正常終了 → 電源断）→ 制御が EC2 の停止を確認して STOPPED。排出が 25 分で終わらなければ `StopInstances`、さらに 10 分で強制停止（記録と通知）。

## 4. 制御（Lambda）の状態機械
`ops/src/aws/controller.ts`（純粋な関数 `applyRequest`・`reconcile`）と `lambda.ts`（CAS で最大 4 回やり直す。副作用は状態を書けた後だけ・冪等）。
| 今 | 条件 | 次 | 副作用 |
|---|---|---|---|
| STOPPED | hold あり | STARTING | StartInstances |
| STOPPED | EC2 が動いている（制御を通さない起動） | STOPPING | 通知 |
| STARTING | ホストが起動の要求の後に READY（MySQL・dashboard）を報告 | NORMAL | DNS の更新 |
| STARTING | 20 分を超えた | （そのまま） | 通知（起動の要求は続ける） |
| STARTING/NORMAL | hold が無い（期限切れ・解放） | STOPPING | （ホストが排出） |
| NORMAL | 予期しない停止 | STARTING | StartInstances・通知 |
| STOPPING | EC2 が stopped | STOPPED | 排出・バックアップの成否を記録（失敗は通知） |
| STOPPING | 25 分で排出が終わらない／さらに 10 分 | （そのまま） | StopInstances／強制停止・通知 |
| STOPPING | EC2 が stopping のまま 35 分（排出 25 + 停止 10） | （そのまま） | 強制停止・通知 |
| 任意 | 連続稼働が `maxRunningHours`（20 時間）を超えた（開催日の hold がある間は**絶対の上限 36 時間**まで待つ） | hold を外す → STOPPING | 通知（停止し忘れの安全網） |
| 任意 | 開催の計画が無い・10 日より古い | 計画が読めない間は動いている開催日の hold を期限まで保つ | 通知（1 日 1 回） |

- 二重の起動・起動中の再要求: hold の upsert なので冪等（同じ目的の hold は 1 つ）。起動中の停止要求・停止中の起動要求: どちらも次の収束で正しい向きになる（停止中に hold が来たら、EC2 が stopped になった時点で STOPPED → 次の実行で STARTING）。
- 古い自動停止: hold の期限は「延長した時刻」で決まり、停止は「hold が無い」ことでしか起きない。`view-end` は `requested_at` より後に更新された VIEW を外さない。
- 閲覧の期限で、開催日の処理・batch を止めない（それぞれ別の hold）。
- 運用状態が壊れていたら何もしない（推測で書き換えない）。**書く前にも検査し、通らなければ例外**（Lambda のエラー → アラーム。黙って止まらない）。状態は上限を超えないように作る（手動の開催日 30 件・飛ばす日 60 件〔昨日より前は捨てる〕・開催日の hold 3 つ・日付は昨日〜90 日先）。
- **定期実行の失敗**（4 回の競合・起動・停止・DNS・ビーコン・通知の失敗）は例外にする（アラーム）。送れなかった一度だけの警告は印を外して次の実行で送り直す。再実行（Re-run）の要求は元の時刻を使わない。ホストの報告が壊れていたら「無い」として扱う。
- 要求の時刻は GitHub の実行の作成時刻（runner の待ちで閲覧の延長と終了の順序が逆転しない）。
- **DNS**: 動いている間は公開 IP、止まったら文書用のアドレス 192.0.2.1（手放した IP を他人が拾っても、この名前に届かない・証明書を取らせない）。1 時間ごとに書き直す。

## 5. ホスト（EC2）
- Amazon Linux 2023（arm64）。user data（初回だけ）: Docker・ECR の資格情報ヘルパー・Node 24（SHA-256 を確認）・データ用 EBS の初期化（**ファイルシステムが無いときだけ**）・swap・systemd。
- 運用エージェント `jrabot-host`（`ops/src/aws/hostctl.ts` を esbuild で 1 ファイルに。S3 の `host/` から起動のたびに SHA-256 を確かめて取得）。
  - `boot`: SSM の秘密を tmpfs（/run/jrabot）へ → DB の利用者 → `db-migration --mode=validate`（**未適用があれば起動しない**。適用は deploy だけ）。
  - `tick`（1 分ごと）: 判断は `host.ts` の `planHost`（純粋）。閲覧だけなら MySQL・dashboard・oauth2-proxy・Caddy だけ。開催日は ingest と calendar-check（5 分ごと）→ spool（`JOB_LAUNCHER=spool`。web D-283）で bot-run。STOPPING を見たら排出。
  - boot・tick・deploy・backup・restore は `flock` で同時に動かさない（run-batch は長いので除外。排出は tick が止める）。
  - `/data`（データの EBS）がマウントされていなければ起動しない（空の DB を作らない）。spool の起動は 1 回の実行で 1 つまで。照合（reconcile）が失敗した開催日は終わりにしない（15 分ごとに再試行）。
  - **ホストの稼働の上限**（`max_uptime_hours` 既定 30 時間）: 制御が止まっているように見える（運用状態が 3 時間以上書かれていない。動いている間は 1 時間ごとに書かれる）ときだけ、自分で排出して止まる（制御が動いていれば停止は制御に任せる）。
- コンテナ（`services.ts`）: `--cap-drop ALL`・`no-new-privileges`・読取り専用（アプリ）・メモリ上限（スワップなし）・ログの上限・digest で固定。公開ポートは Caddy の 80/443 と 127.0.0.1 だけ（MySQL はどこにも公開しない）。
- **IMDS の遮断**: インスタンスのロールはアプリ（S3 の運用状態・モデル）のためにコンテナから使えるようにしている（ホップ 2）。インターネットに面する Caddy・oauth2-proxy と MySQL は IMDS に届かない固定 IP（172.30.0.128/25）で動かし、`DOCKER-USER` の規則で 169.254.169.254 への通信を落とす。**残るリスク**: アプリのコンテナ（dashboard・ingest・bot）が乗っ取られると、インスタンスのロールの権限に届く: SSM の秘密の読取り（ビーコンの署名鍵は明示的に拒否）、ホストの報告・開催の計画の偽造（早すぎる停止・余計な起動 = 費用）、版のファイルの書換え。版のファイルについては、ホストが**このアカウントの ECR の jra-bot/<名前> と許可したサードパーティの出どころ（tag + digest）のイメージだけ**を動かす（`assertTrustedImages`）ので、別のイメージは動かせない（古い版への差し替えは残る）。根本の対策（アプリの資格情報をホストのロールから分ける）は後続の課題。
- メモリ（上限の合計）: 常駐（MySQL 448・dashboard 288・ingest 288・oauth2-proxy 64・Caddy 64 MiB）+ bot-run 384 + タスク 256 = 1,792 MiB ≤ 1,810（試験 `aws-services`）。batch・ml-train（1,024 MiB）は開催日には動かさない。

## 6. 認証・認可（本人だけ）
| 入口 | 認証 | 備考 |
|---|---|---|
| 画面 `https://<サイト>/` | Cognito（パスワード + TOTP の MFA）→ oauth2-proxy（`--authenticated-emails-file` で本人のメールだけ）→ dashboard が **ID トークンの署名・iss・aud・token_use・exp・email_verified を検証** | クライアントが付けたヘッダは信用しない（oauth2-proxy が Authorization を上書き。dashboard は署名を検証）。Cookie は `__Host-`・Secure・HttpOnly |
| `/v1/agent/*` | エージェントのトークン（ingest。web CONTRACTS §8）| Cognito を通さない（機械）。閲覧だけの起動では ingest が動いていない |
| `/internal/*` | Caddy で 404（外から届かない）。内部は `INTERNAL_OPS_TOKEN_FILE`（起動ごとに作る乱数・定数時間比較） | |
| 起動・停止・状態・deploy | GitHub Actions（infra・`environment: ops`・main だけ）→ OIDC（`sub = repo:<owner>/jra-bot-infra:environment:ops`）→ IAM ロール | ロールの権限: Lambda の呼出し・SSM Run Command（このインスタンスと**専用のドキュメント `<prefix>-host-command` だけ**: `jrabot-host deploy|backup|run-batch`、引数は英数字と `=.,_:/ -` だけ。任意のシェルは送れない）・`control/release-candidate.json` の書込み・SSM の秘密の作成（`PutParameter` だけ。値を読む権限は無い） |
| web のイメージの push | `environment: release` の OIDC → ECR の push だけ（`enableWebPush=true` の後） | |
| 管理者 | SSM Session Manager（コンソール・CloudShell） | SSH なし・22 番を開けない |

**未認証の公開 URL は EC2 を起動できない**（停止中は名前が古い IP を指すか、届かない。起動は GitHub の手動実行だけ）。

## 7. データ保護
- データ用 EBS は Pulumi で `protect`・`retainOnDelete`、EC2 は `disableApiTermination`、user data はファイルシステムがあれば初期化しない。コンテナの作り直し・EC2 の停止で消えない。
- バックアップ: 停止のたび・deploy の前・restore の前・手動（`aws-backup`）に mysqldump `--single-transaction`（整合）→ gzip → S3（`IfNoneMatch` で上書きしない・SHA-256 を記録して読み直して確認）。**失敗を成功と報告しない**（ホストの報告 → 制御の `last_stop.backup_ok` → 通知）。保持 35 日（ライフサイクル）・旧版 7 日。ホストのロールは削除できない。
- 復元: `jrabot-host restore --key … --confirm RESTORE-<日付>`（**保守の起動目的が 90 分以上残っている NORMAL** のときだけ。開催日・重い処理・ジョブの最中は拒否。直前に現状のバックアップ → dump の最後の行を確認 → DB を作り直して流し込む。流し込みの失敗は直前のバックアップのキーを表示）。合成データで dump → 別の MySQL へ復元 → 全表のチェックサム一致を CI で確認（`ops/it/backup-restore.mjs`。Flyway の実スキーマ 38 表でも確認）。
- 実データ・秘密・学習済みモデルを Git に入れない。**COMP-4 の回答までは実データを AWS に入れない**（web UNRESOLVED）。

## 8. 版数（固定）
@pulumi/aws 7.52.1、@aws-sdk/client-* 3.1160.0、esbuild 0.28.2、AWS SDK for Java 2.57.5（web）、Node v24.22.2（SHA-256 固定）、mysql:8.4.11・caddy:2.11.6（digest 固定）、oauth2-proxy v7.15.3（digest は deploy の前に本人が確認して `hostImages` に入れる: `AWS_OPERATIONS.md` U5）。

## 9. GCP の定義との関係
`terraform/`・`pulumi/`（GCP）と GCP 向けの workflow（ops-start・ops-stop・ops-status・deploy）は**切替が終わるまで残す**（切戻し用）。AWS の定義は `pulumi-aws/`、運用は `aws-*` の workflow。同じ時期に両方で bot・Scheduler を動かさない手順は `AWS_OPERATIONS.md` §7。
