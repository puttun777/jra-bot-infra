# AWS の運用手順（Runbook。2026-11-13）

構成は `AWS_ARCHITECTURE.md`、費用は `CLOUD_COSTS.md` §12。**ここに書いた AWS の操作は、まだ一度も実環境で実行していない**（試験は mock・合成データ・ローカルの Docker まで。§11）。
操作はすべて GitHub の infra リポジトリの **Actions → 対象の workflow → Run workflow**（スマホのブラウザ・GitHub アプリからも可）。結果は実行の Summary に Markdown で出る。

## 0. 本人が用意するもの（U1〜U12）
| ID | 内容 | 方法・注意 |
|---|---|---|
| U1 | AWS アカウント（東京リージョンを使う）と、**ルートを使わない管理者**（IAM Identity Center の利用者 + MFA） | 長期のアクセスキーを作らない。Pulumi は `aws sso login` の短期の資格情報で実行する |
| U2 | **独自ドメイン**（画面の HTTPS・Cognito の戻り先に必要）。例 `jrabot.example.com` | 既に持っているドメインのサブドメインでよい（購入は本人の判断）。Route 53 にホストゾーンを作る（`createZone=true`）か既存のゾーン ID を渡す。親のドメインの DNS に NS を委任する（`zone_name_servers` の出力） |
| U3 | Pulumi の state の置き場: S3 バケット（例 `jrabot-pulumi-state-<アカウントID>`、バージョニング有効・公開ブロック）と、秘密の暗号化のパスフレーズ | `pulumi login s3://<バケット>?region=ap-northeast-1`、`PULUMI_CONFIG_PASSPHRASE` はパスワード管理に保存（Git に入れない） |
| U4 | Amazon Linux 2023 の arm64 の AMI ID（東京） | `aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --region ap-northeast-1 --query Parameter.Value --output text`。**固定する**（変えるとインスタンスの作り直しになるので Pulumi は無視する） |
| U5 | サードパーティのイメージの digest | `docker buildx imagetools inspect quay.io/oauth2-proxy/oauth2-proxy:v7.15.3` の `Digest`（index）。mysql・caddy は `pulumi-aws` の試験と同じ値（`mysql:8.4.11@sha256:0f51e63e…`・`caddy:2.11.6@sha256:3422ce6d…`）を使える。**3 つとも `tag@sha256:` で固定**（形式は検査される） |
| U6 | Discord の Webhook（通常・エラー） | **チャットに貼らない**。CloudShell で `aws ssm put-parameter --name /jra-bot/discord-webhook --type SecureString --value '<URL>'`（`discord-error-webhook` も）。制御（Lambda）の通知はエラー用の Webhook を使う |
| U7 | アプリの運用値（`appEnv`）: `CALENDAR_*`・`BOT_RUN_*`（web CONTRACTS §2。**既定値は無い**） | GCP の Terraform の変数と同じ値。秘密は入れない（検査で拒否） |
| U8 | GitHub の environment `ops`（infra）: main だけ・必要なら承認者に本人 | 変数（§1.4）を置く。秘密は置かない（OIDC なので不要） |
| U9 | web の environment `release` の変数 `AWS_ACCOUNT_ID`・`AWS_PUSH_ROLE_ARN` | `enableWebPush=true` で Pulumi がロールを作った後（**IAM の変更なので本人の承認**） |
| U10 | Windows エージェントの設定の変更（ビーコンの URL・検証鍵・送信先） | §1.6 |
| U11 | Cognito の初回ログイン（仮パスワードはメールで届く → 本パスワード → TOTP の登録） | 認証アプリ（Google Authenticator 等）。復旧はメール |
| U12 | 予算の通知の宛先（`budgetEmail`）と金額（`budgetUsd`。既定 $20） | **通知だけで、止まらない** |

## 1. 初回の構築（本人の承認の後）
1.1 **事前の確認（課金なし）**: infra の CI が緑、`npm ci --ignore-scripts && npm test`（mock・合成データ）が通ること。
1.2 **設定**（PC。`pulumi-aws/` で）:
```bash
npm ci --ignore-scripts && npm run build && npm run bundle:aws
cd pulumi-aws
pulumi login 's3://<U3 のバケット>?region=ap-northeast-1'
pulumi stack init prod --secrets-provider passphrase
pulumi config set jrabot-aws:prefix jrabot-<アカウントIDの下4桁など>
pulumi config set jrabot-aws:accountId <12 桁>
pulumi config set jrabot-aws:amiId <U4>
pulumi config set jrabot-aws:siteHost <U2 の FQDN>
pulumi config set jrabot-aws:createZone true     # または dnsZoneId <既存のゾーン ID>
pulumi config set jrabot-aws:zoneName <U2 のゾーン名>
pulumi config set jrabot-aws:cognitoDomainPrefix <世界で一意の英小文字>
pulumi config set jrabot-aws:ownerEmail <本人のメール>
pulumi config set jrabot-aws:githubOwner <GitHub の所有者>
pulumi config set jrabot-aws:budgetEmail <U12>
pulumi config set jrabot-aws:hostImages '{"mysql":"mysql:8.4.11@sha256:…","caddy":"caddy:2.11.6@sha256:…","oauth2Proxy":"quay.io/oauth2-proxy/oauth2-proxy:v7.15.3@sha256:…"}'
pulumi config set jrabot-aws:appEnv '{"CALENDAR_WATCH_START_MINUTES":"…", …, "BOT_RUN_DECISION_PROFILE":"…"}'
```
1.3 **確認と適用**: `pulumi preview`（作るものの一覧。課金リソース: EC2・EBS 2 本・S3 4 本・ECR 5・Lambda・Scheduler・Cognito・Route 53 のゾーン・Budgets・DLM）→ 本人が内容を確認 → `pulumi up`。EC2 は作成と同時に起動するが、起動目的が無いので制御が数分で止める（『制御を通さない起動』の通知が出るのは正常。版も秘密もまだ無いのでアプリは動かない）。
1.4 **GitHub の変数**（infra の environment `ops`。値は `pulumi stack output`）:
`AWS_OPS_ROLE_ARN`=ops_role_arn、`AWS_CONTROLLER_FUNCTION`=controller_function、`AWS_INSTANCE_ID`=instance_id、`AWS_STATE_BUCKET`=state_bucket、`AWS_SSM_PREFIX`=`/jra-bot`、`AWS_HOST_IMAGES`=host_images（JSON のまま）、`AWS_ARCH`=arch。
1.5 **秘密の作成**: Actions → `aws-secrets-init`（DB のパスワード・Cookie・ペッパー・KEK・ビーコンとモデルの署名鍵を SSM に作る。**既にあるものは上書きしない**）。続けて U6 の Discord。
1.6 **イメージ**: web で `enableWebPush=true`（`pulumi config set jrabot-aws:enableWebPush true` → `pulumi up`）→ web の release（target=aws・arch=arm64）→ リリースの `release-manifest.json` の URL と SHA-256 で §6 の `aws-deploy`。
1.7 **Windows エージェント**（U10）: `aws-status` の「ビーコンの検証鍵」（kid と公開鍵）、`beacon_url`（出力）、送信先 `https://<siteHost>`（`/v1/agent/*`）をエージェントの設定に入れる。エージェントのトークンの登録は dashboard の管理画面（web CONTRACTS §8）。
1.8 **初回ログイン**: `aws-view` → 表示された URL → Cognito（U11）。

## 2. 閲覧（スマホ可）
1. Actions → **aws-view** → minutes（既定 60）・wait（既定オン）→ Run。
2. 数分後に Summary に「利用可能: はい」と URL が出る（**受付と準備完了を区別**: 受付直後は「接続先: 準備完了まで表示しない」）。起動に 20 分を超えると Discord に通知。
3. **延長**: もう一度 aws-view を実行（期限は「今から N 分」。短くならない）。
4. **終了**: aws-stop（scope=view-end）。期限が来れば自動で止まる。
- 閲覧だけの起動では **bot・Discord の通知・ingest・重い処理は動かない**（`workloads.raceday=false`。アプリ側でも拒否）。開催日の時間帯なら開催日の起動目的で既に動いている（閲覧の終了で止まらない）。

## 3. 開催日（自動）
- アプリの `calendar-plan`（NORMAL の間 6 時間ごとと開催日の終わり）が今後 21 日の開催日を S3 に書き、制御が **最初の発走の 240 分前**に起動 → ingest・calendar-check・bot-run → **最後の発走の 150 分後**まで、またはホストが「その日の処理が終わった（払戻・照合まで）」と報告したら停止。
- 計画が古い・無い（初回など）ときは、`aws-raceday`（action=add・date）で手動登録する（発走時刻を省略すると 09:50〜16:40 JST を仮定）。**中止・休む日**は action=skip。
- 当日の確認: `aws-status` の「起動目的: RACEDAY(日付)」「ホスト… bot_run」「許された処理 raceday=true」。Windows エージェントの接続は dashboard のエージェントの画面（最終の受信）と、status の `host.ready.ingest`。
- 連続 20 時間を超えた稼働は止める（停止し忘れの安全網。値は `controller.maxRunningHours`）。

## 4. 停止
- 閲覧だけ終える: **aws-stop**（view-end）。開催日・batch は止めない。
- すべて止める: **aws-stop**（stop-all・理由）。今日の開催日も再起動しない（再開は aws-raceday add）。
- 停止は制御が行う（受付の停止 → 実行中の処理の終了 → バックアップ → MySQL の正常終了 → 電源断 → STOPPED）。**データは消さない**。status の「最後の停止」に clean・backup_ok・forced が出る。clean=false・backup_ok=false は Discord に通知。
- 止まらないとき: 25 分で StopInstances、さらに 10 分で強制停止（自動）。それでも running のまま → AWS コンソールの EC2 で状態を確認し、「インスタンスを停止」（強制停止は最後の手段。MySQL はクラッシュ回復で戻るが、直後に status でバックアップを確認）。
- **停止し忘れの検知**: 制御の上限（20 時間）・Discord の通知・Budgets の通知（遅れる）。月に一度は AWS の請求のページで EC2 の時間を確認する。

## 5. 重い処理（バックテスト・データセット・学習）
Actions → **aws-batch**（task・args・minutes・reason）。開催日の処理中は拒否される。終わると起動目的を外す（他が無ければ停止）。引数は許可したものだけ（例 `--from=2026-01-01 --to=2026-06-30`）。

## 6. デプロイ（イメージの更新）
1. web の release（target=aws・arch=arm64）→ リリースの資産 `release-manifest.json` の URL と SHA-256（リリースの本文）を控える。
2. Actions → **aws-deploy**（URL・SHA-256）。取得 → SHA-256 → スキーマ・契約の版・CPU の確認 → `control/release-candidate.json` → 保守の起動目的で起動 → ホストで **バックアップ → 候補の版で準備（未適用のマイグレーションはここで適用）→ 入れ替え**。成功したときだけ `control/release.json` に昇格（前の版は `release-previous.json`）。最後に準備完了を待って保守の起動目的を外す。
3. **開催日の処理の最中は拒否**（終わってから）。
4. 失敗したとき: ホストは自動で前の版に戻す（`control/release.json` は変わらない = 次の起動も前の版）。**DB は前進だけ**: マイグレーションが成功した後に失敗した場合は、前の版の `validate` が「未適用」ではなく「新しすぎる」で失敗して止まる → 修正した版で再度 deploy する（DB を戻すのは §8 の復元だけ。実データの不可逆な操作なので本人の判断）。
5. 切戻し（前の版に戻す）: 前の版の release-manifest で aws-deploy を実行する（`rollback.min_app_release` の範囲だけ。スキーマが新しい版より前には戻せない）。

## 7. GCP からの切替・切戻し（二重に動かさない）
**前提**: COMP-4 の回答までは実データを AWS に入れない（web UNRESOLVED）。それまでは合成データで §1〜§6 を確認する。
1. AWS を合成データで構築・確認（§1〜§6、§8 の復元の練習）。この間、**AWS の開催日の起動は止めておく**: 計画が来ないように `aws-raceday skip` を当日分に入れるか、エージェントの送信先を GCP のままにする（ビーコンは別の URL なのでエージェントは AWS に送らない）。
2. 切替日（開催日でない日）: GCP の `ops-stop`（mode=STOPPED・Scheduler 停止・bot の Job を起動しない）→ `ops-status` で STOPPED を確認。
3. データの移行（本人の判断・COMP-4 の後）: GCP の Cloud SQL から mysqldump（`--single-transaction`）→ AWS の EC2 で `jrabot-host restore` と同じ手順で投入（S3 の `mysql/` に置いて `restore --key … --confirm RESTORE-<日付>`）→ `db-migration validate`。
4. Windows エージェントの設定を AWS（ビーコンの URL・検証鍵・送信先）に変える（§1.7）。
5. AWS の開催日の起動を有効にする（skip を外す: `aws-raceday add`）。最初の開催日は aws-status と Discord で確認。
6. **GCP は消さない**（Cloud SQL を停止・Scheduler を停止のまま。費用は CLOUD_COSTS §10.3）。AWS で 2〜4 開催日を問題なく終えてから、GCP の削除を本人が判断する（`terraform destroy` 等は本人）。
- **切戻し**: AWS の `aws-stop`（stop-all）→ 制御の Scheduler を止める（`aws scheduler update-schedule … --state DISABLED` を CloudShell で。または Pulumi で）→ AWS の最新のバックアップを GCP に戻すか（AWS で増えたデータを持ち帰る）、GCP の停止時点から再開 → エージェントの設定を GCP に戻す → GCP の `ops-start`。
- 同時に動かさない仕組み: 運用状態はクラウドごとに別。エージェントは設定した 1 つのビーコンしか見ない。bot の通知は各クラウドの bot-run だけが出す → **両方の開催日の起動を同時に有効にしない**ことを手順で守る（切替日に GCP を先に止める）。

## 8. バックアップ・復元
- 自動: 停止のたび・deploy の前。手動: **aws-backup**。S3 `mysql/<JST の日付>/jrabot-<時刻>-<理由>.sql.gz`（SHA-256 をメタデータに記録して読み直して確認）。保持 35 日・旧版 7 日。EBS のスナップショット（週 1・2 世代）は予備。
- 復元（実データなら本人の判断）: Session Manager でインスタンスに入り `sudo /opt/jrabot/bin/jrabot-host restore --key mysql/…/….sql.gz --confirm RESTORE-<その日付>`（直前に現状のバックアップを取る）→ status で確認。試験は CI の `aws-backup-restore`（合成データ）。
- データ用 EBS からの復元（S3 も使えないとき）: スナップショットからボリュームを作り、EC2 を止めて付け替える（コンソール。Pulumi の state と食い違うので、後で `pulumi import` か設定の更新が必要）。

## 9. 困ったとき
| 症状 | 確認 | 対処 |
|---|---|---|
| aws-view が「利用可能: いいえ」のまま | status の host.phase・ready | BOOTING のまま → Session Manager で `journalctl -u jrabot-boot -n 50`。「未適用のマイグレーション」→ aws-deploy。「control/release.json を読めない」→ 初回の deploy がまだ |
| 画面が開けない（証明書・名前） | status の url、`dig <siteHost>` | IP の更新は起動のたびに Lambda が行う（TTL 60 秒。1 時間ごとに書き直す）。証明書は初回の取得に数分 |
| Cognito でログインできない | 本人のメールか・MFA | 管理者がコンソールでパスワードの再設定 |
| 停止が clean=false | Discord・status の last_stop | 次の起動後に aws-backup で取り直す |
| 「停止し忘れ」 | status の holds・auto_stop_at | aws-stop（stop-all） |
| ネットワークの範囲の違い（boot の失敗） | `docker network inspect jrabot` | 全コンテナを止めて `docker network rm jrabot` → `systemctl restart jrabot-boot` |
| モデルの鍵の入替え | — | 新しい署名鍵を SSM に置く（旧い鍵で署名したモデルは再学習・再署名）。複数の検証鍵の併用は未対応（必要になったら web の CONTRACTS §5.1 に合わせて追加） |

## 10. 費用の確認と、残りやすい有料リソース
- 停止中も課金されるもの: EBS（ルート 12 GB + データ 16 GB）・スナップショット・S3・ECR・Route 53 のゾーン・（ごく少額）Lambda・Scheduler。**EC2 と公開 IPv4 は停止中は課金されない**（Elastic IP を作らない）。
- 片付けるときに残りやすいもの: データ用 EBS（`retainOnDelete`）・Cognito（削除保護）・S3（中身があると消えない）・スナップショット・ECR のイメージ・CloudWatch のロググループ・Route 53 のゾーン。削除は本人の判断（実データの削除）。
- Budgets は**通知だけ**（止まらない）。

## 11. 未実施（実環境が必要）
`pulumi preview/up`、Lambda の実行、EC2 の起動と user data、Cognito のログイン、Let's Encrypt の取得、Route 53 の更新、SSM Run Command、ECR への push・pull、arm64 の実機での JVM の起動とメモリ、S3 の条件付き書込みの実挙動（偽の S3 で試験）、Windows エージェントとの接続、GCP からの実データの移行。初回の構築のときに §1 の順で確かめ、結果を PROGRESS に記録する。
