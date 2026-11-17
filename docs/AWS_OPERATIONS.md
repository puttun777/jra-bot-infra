# AWS の運用手順（Runbook。2026-11-13・2026-11-17 改訂: 独自ドメインなし）

構成は `AWS_ARCHITECTURE.md`、費用は `CLOUD_COSTS.md` §13。**ここに書いた AWS の操作は、まだ一度も実環境で実行していない**（試験は mock・合成データ・ローカルの Docker まで。§11）。
操作はすべて GitHub の infra リポジトリの **Actions → 対象の workflow → Run workflow**（スマホのブラウザ・GitHub アプリからも可）。結果は実行の Summary に Markdown で出る。

**前提: AWS アカウントはあり、独自ドメインは持っていない**。ドメインの購入・DNS（Route 53 のゾーン・NS の委任）・証明書（ACM・Let's Encrypt）の準備は**不要**。公開 URL は CloudFront の標準の `https://<distribution>.cloudfront.net`（Pulumi が作り、出力 `site_url` に出る。I-050）。

## 0. 本人が用意するもの（U1〜U13）
| ID | 内容 | 方法・注意 |
|---|---|---|
| U1 | AWS アカウント（東京リージョンを使う）と、**ルートを使わない管理者**（IAM Identity Center の利用者 + MFA） | 長期のアクセスキーを作らない。Pulumi は `aws sso login` の短期の資格情報で実行する |
| U2 | Pulumi の state の置き場: S3 バケット（例 `jrabot-pulumi-state-<アカウントID>`、バージョニング有効・公開ブロック）と、秘密の暗号化のパスフレーズ | `pulumi login s3://<バケット>?region=ap-northeast-1`、`PULUMI_CONFIG_PASSPHRASE` はパスワード管理に保存（Git に入れない。KMS の鍵の月額を避ける） |
| U3 | Amazon Linux 2023 の arm64 の AMI ID（東京） | `aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --region ap-northeast-1 --query Parameter.Value --output text`。**固定する**（変えるとインスタンスの作り直しになるので Pulumi は無視する） |
| U4 | アベイラビリティゾーンの **ID**（`apne1-az1`・`apne1-az2`・`apne1-az4` のどれか。既定 `apne1-az1`） | **`apne1-az3` は CloudFront の VPC origin が使えない**（設定の検査で拒否）。t4g.small があるか: `aws ec2 describe-instance-type-offerings --location-type availability-zone-id --filters Name=instance-type,Values=t4g.small --region ap-northeast-1 --query 'InstanceTypeOfferings[].Location'` |
| U5 | サードパーティのイメージの digest | `docker buildx imagetools inspect quay.io/oauth2-proxy/oauth2-proxy:v7.15.3` の `Digest`（index）。mysql・caddy は `pulumi-aws` の試験と同じ値（`mysql:8.4.11@sha256:0f51e63e…`・`caddy:2.11.6@sha256:3422ce6d…`）を使える。**3 つとも `tag@sha256:` で固定**（形式は検査される） |
| U6 | Discord の Webhook（通常・エラー） | **チャットに貼らない**。CloudShell で `aws ssm put-parameter --name /jra-bot/discord-webhook --type SecureString --value '<URL>'`（`discord-error-webhook` も）。制御（Lambda）の通知はエラー用の Webhook を使う |
| U7 | アプリの運用値（`appEnv`）: `CALENDAR_*`・`BOT_RUN_*`（web CONTRACTS §2。**既定値は無い**） | GCP の Terraform の変数と同じ値。秘密は入れない（検査で拒否）。infra が決める値（`RUNTIME_PLATFORM`・`COGNITO_*`・`ALLOWED_USERS`・`ADMIN_USERS`・`OPS_MODE_SOURCE`）は入れられない |
| U8 | GitHub の environment `ops`（infra）: main だけ・必要なら承認者に本人 | 変数（§1.4）を置く。秘密は置かない（OIDC なので不要） |
| U9 | 予算の通知の宛先（`budgetEmail`）と金額（`budgetUsd`。既定 $20） | **通知だけで、止まらない**。同じ宛先に制御の失敗のアラーム（SNS）のメールが届く: 最初に届く「購読の確認」のリンクを開く |
| U10 | web の environment `release` の変数 `AWS_ACCOUNT_ID`・`AWS_PUSH_ROLE_ARN` | `enableWebPush=true` で Pulumi がロールを作った後（**IAM の変更なので本人の承認**） |
| U11 | Windows エージェントの設定の変更（ビーコンの URL・検証鍵・送信先 = `site_url`） | §1.7 |
| U12 | Cognito の初回ログイン（仮パスワードはメールで届く → 本パスワード → TOTP の登録） | 認証アプリ（Google Authenticator 等）。復旧はメール。**自己登録はできない**（本人の 1 人だけを Pulumi が作る） |
| U13 | Cognito のドメインの接頭辞（`cognitoDomainPrefix`。**世界で一意**の英小文字・数字・ハイフン）と、本人のメール（`ownerEmail`。**小文字**の英数字と `._%+-` だけ。Cognito の利用者も同じメール） | 接頭辞はログイン画面の URL `https://<接頭辞>.auth.ap-northeast-1.amazoncognito.com` になる（ドメインの購入ではない）。使われていればエラー → 別の名前。メールの形がホストの検査と違うと、`pulumi up` の前に設定の検査で止まる |

## 1. 初回の構築（本人の承認の後）
1.1 **事前の確認（課金なし）**: infra の CI が緑、`npm ci --ignore-scripts && npm test`（mock・合成データ）が通ること。
1.2 **設定**（PC。`pulumi-aws/` で）:
```bash
npm ci --ignore-scripts && npm run build && npm run bundle:aws
cd pulumi-aws
pulumi login 's3://<U2 のバケット>?region=ap-northeast-1'
pulumi stack init prod --secrets-provider passphrase
pulumi config set jrabot-aws:prefix jrabot-<アカウントIDの下4桁など>
pulumi config set jrabot-aws:accountId <12 桁>
pulumi config set jrabot-aws:amiId <U3>
pulumi config set jrabot-aws:availabilityZoneId apne1-az1   # U4（az3 は不可）
pulumi config set jrabot-aws:cognitoDomainPrefix <U13>
pulumi config set jrabot-aws:ownerEmail <本人のメール>
pulumi config set jrabot-aws:githubOwner <GitHub の所有者>
pulumi config set jrabot-aws:budgetEmail <U9>
pulumi config set jrabot-aws:hostImages '{"mysql":"mysql:8.4.11@sha256:…","caddy":"caddy:2.11.6@sha256:…","oauth2Proxy":"quay.io/oauth2-proxy/oauth2-proxy:v7.15.3@sha256:…"}'
pulumi config set jrabot-aws:appEnv '{"CALENDAR_WATCH_START_MINUTES":"…", …, "BOT_RUN_DECISION_PROFILE":"…"}'
# 既にアカウントに GitHub の OIDC プロバイダがあれば: pulumi config set jrabot-aws:githubOidcProviderArn arn:aws:iam::<12 桁>:oidc-provider/token.actions.githubusercontent.com
```
ドメイン・ゾーン・証明書の設定は無い。廃止した設定（`siteHost`・`dnsZoneId`・`createZone`・`zoneName`・`availabilityZone`）がスタックに残っていると、`pulumi preview/up` が止まる（`pulumi config rm jrabot-aws:<名前>` で消す）。

1.3 **確認と適用**: `pulumi preview`（作るものの一覧。課金リソース: EC2・EBS 2 本・S3 5 本〔ops-state・beacon・models・backups・site〕・ECR 5・Lambda・Scheduler・Cognito・**CloudFront の distribution・VPC origin**・Budgets・DLM・CloudWatch のアラーム 2）→ 本人が内容を確認 → `pulumi up`。
- **作成の順序（自動）**: VPC・サブネット → EC2（作成と同時に起動する）→ **VPC origin**（EC2 が running である必要がある。作成に最大 15 分）→ CloudFront の管理 SG（`CloudFront-VPCOrigins-Service-SG…`）を探して EC2 の SG に 80 番の受信を追加 → **distribution**（配布の完了を待つ。数分〜15 分）→ Cognito の App client（callback = `<site_url>/oauth2/callback`）→ S3 `control/site.json` → Lambda（`SITE_URL`）→ **最後に Scheduler**。Scheduler が最後なので、作成の途中で制御が EC2 を止めない。
- `pulumi up` が VPC origin の作成で「インスタンスが Active でない」と失敗したら: EC2 が running か確かめ（コンソール）、もう一度 `pulumi up`。
- 作成の後、Scheduler の最初の実行で制御が「起動目的が無い」EC2 を止める（『制御を通さない起動』の通知が出るのは正常。版も秘密もまだ無いのでアプリは動かない）。
- **途中で失敗したとき**（例: VPC origin・distribution の作成の失敗。新しいアカウントでは CloudFront の作成がアカウントの確認待ちで拒否されることがある → AWS サポートへ）: Lambda・Scheduler はまだ無いので、**EC2 を止める者がいない**（約 $0.027/時。ops のロールにも停止の権限は無い）。中断するならコンソールで EC2 を停止する。再実行の前には EC2 を開始する（VPC origin の作成には running の EC2 が要る）→ `pulumi up`。
- 出力の `site_url`（`https://d….cloudfront.net`）が公開 URL。**ブックマーク・Windows エージェントの送信先に使う**。distribution を作り直さない限り変わらない。

1.4 **GitHub の変数**（infra の environment `ops`。値は `pulumi stack output`）:
`AWS_OPS_ROLE_ARN`=ops_role_arn、`AWS_CONTROLLER_FUNCTION`=controller_function、`AWS_INSTANCE_ID`=instance_id、`AWS_HOST_COMMAND_DOCUMENT`=host_command_document、`AWS_STATE_BUCKET`=state_bucket、`AWS_SSM_PREFIX`=`/jra-bot`、`AWS_HOST_IMAGES`=host_images（JSON のまま）、`AWS_ARCH`=arch。
1.5 **秘密の作成**: Actions → `aws-secrets-init`（DB のパスワード・Cookie・ペッパー・KEK・ビーコンとモデルの署名鍵を SSM に作る。**既にあるものは上書きしない**）。続けて U6 の Discord。CloudFront → EC2 の合言葉（`/jra-bot/origin-verify`）は Pulumi が作る（ここでは作らない）。
1.6 **イメージ**: web で `enableWebPush=true`（`pulumi config set jrabot-aws:enableWebPush true` → `pulumi up`）→ web の release（target=aws・arch=arm64）→ リリースの `release-manifest.json` の URL と SHA-256 で §6 の `aws-deploy`。
1.7 **Windows エージェント**（U11）: `aws-status` の「ビーコンの検証鍵」（kid と公開鍵）、`beacon_url`（出力）、送信先 `server.base_url = <site_url>`（`/v1/agent/*` は ingest へ。Cognito を通らない）をエージェントの設定に入れる。エージェントのトークンの登録は dashboard の管理画面（web CONTRACTS §3.3）。
1.8 **初回ログイン**: `aws-view` → 表示された URL（= `site_url`）→ Cognito（U12）→ 画面。本人の利用者の行（`app_user` の ADMIN）はホストが boot で作る（無ければ 403 になる。§9）。
1.9 **初回の確認（実環境でしかできない。結果を PROGRESS に記録）**: §11 の V-1〜V-6（VPC origin の到達・作成の順序・停止/起動の後の復帰とエラーの応答〔ingest の 503 の `X-Ops-Mode`・4xx の JSON が CloudFront を通っても同じ〕・管理 SG の名前・Cognito のログイン/ログアウトと dashboard が見る Host・直接の接続の拒否〔EC2 の公開 IPv4 の 80 番に届かない・合言葉なしは 403〕）。

## 2. 閲覧（スマホ可）
1. Actions → **aws-view** → minutes（既定 60）・wait（既定オン）→ Run。
2. 数分後に Summary に「利用可能: はい」と URL が出る（**受付と準備完了を区別**: 受付直後は「接続先: 準備完了まで表示しない」。準備完了は、ホストの READY に加えて **CloudFront 経由で `/_jrabot/health` が届いたこと**）。起動に 20 分を超えると Discord に通知（CloudFront 経由の確認の結果も書く）。
3. **延長**: もう一度 aws-view を実行（期限は「今から N 分」。短くならない）。
4. **終了**: aws-stop（scope=view-end）。ログアウトだけなら `<site_url>/logout` を開く（画面にリンクは無い。EC2 は止まらない）。期限が来れば自動で止まる。
- URL をブラウザで開いただけでは起動しない。止まっている・起動中は「jra-bot は停止中です」の案内（HTTP 503。キャッシュしないので、起動の後に開き直せば画面になる）。
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
- 停止・起動で公開 URL は変わらない（CloudFront の distribution と VPC origin はそのまま。EC2 の IP は変わるが使っていない）。

## 4b. 保守のための起動
Actions → **aws-maintenance**（minutes 180/120・理由）。閲覧と同じく bot・通知・重い処理は動かさない。期限で自動で止まる（もう一度実行すると延長。途中で止めるなら aws-stop の stop-all）。復元（§8）と、VPC origin の作り直し（§9）に使う。

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
4. Windows エージェントの設定を AWS（ビーコンの URL・検証鍵・送信先 `site_url`）に変える（§1.7）。
5. AWS の開催日の起動を有効にする（skip を外す: `aws-raceday add`）。最初の開催日は aws-status と Discord で確認。
6. **GCP は消さない**（Cloud SQL を停止・Scheduler を停止のまま。費用は CLOUD_COSTS §10.3）。AWS で 2〜4 開催日を問題なく終えてから、GCP の削除を本人が判断する（`terraform destroy` 等は本人）。
- **切戻し**: AWS の `aws-stop`（stop-all）→ 制御の Scheduler を止める（`aws scheduler update-schedule … --state DISABLED` を CloudShell で。または Pulumi で。止めると『定期実行が来ない』のアラームのメールが届く）→ AWS の最新のバックアップを GCP に戻すか（AWS で増えたデータを持ち帰る）、GCP の停止時点から再開 → エージェントの設定を GCP に戻す → GCP の `ops-start`。
- 同時に動かさない仕組み: 運用状態はクラウドごとに別。エージェントは設定した 1 つのビーコンしか見ない。bot の通知は各クラウドの bot-run だけが出す → **両方の開催日の起動を同時に有効にしない**ことを手順で守る（切替日に GCP を先に止める）。

## 8. バックアップ・復元
- 自動: 停止のたび・deploy の前。手動: **aws-backup**。S3 `mysql/<JST の日付>/jrabot-<時刻>-<理由>.sql.gz`（SHA-256 をメタデータに記録して読み直して確認）。保持 35 日・旧版 7 日。EBS のスナップショット（週 1・2 世代）は予備。
- 復元（実データなら本人の判断）: **aws-maintenance（180 分）で起動した状態**（開催日・batch の起動目的が無い・保守が 90 分以上残っている）で Session Manager からインスタンスに入り `sudo /opt/jrabot/bin/jrabot-host restore --key mysql/…/….sql.gz --confirm RESTORE-<その日付>`（直前に現状のバックアップを取る → dump の完全性を確認 → DB `jrabot` を作り直して流し込む → **本人の利用者の行を `INSERT IGNORE`**〔戻した dump に無くてもログインできる。既存の行は変えない〕。開催日・batch・ジョブが動いていれば拒否）→ status で確認。流し込みが途中で失敗したら、直前の pre-restore のバックアップで同じ手順を行う。試験は CI の `aws-backup-restore`（合成データ）。
- データ用 EBS からの復元（S3 も使えないとき）: スナップショットからボリュームを作り、EC2 を止めて付け替える（コンソール。Pulumi の state と食い違うので、後で `pulumi import` か設定の更新が必要）。

## 9. 困ったとき
| 症状 | 確認 | 対処 |
|---|---|---|
| aws-view が「利用可能: いいえ」のまま | status の host.phase・ready、Discord の起動の時間切れの通知（「CloudFront 経由=届かない」か） | BOOTING のまま → Session Manager で `journalctl -u jrabot-boot -n 50`。「未適用のマイグレーション」→ aws-deploy。「control/release.json を読めない」→ 初回の deploy がまだ。「site.json を読めない」→ `pulumi up` がまだ・途中。CloudFront 経由が届かない → 下の 503 の行 |
| 画面が「jra-bot は停止中です」（503）のまま | aws-status の mode・EC2、`aws cloudfront get-vpc-origin --id <vpc_origin_id>` の Status | 停止中なら aws-view。NORMAL なのに 503 → VPC origin が `Deployed` か、EC2 の SG に管理 SG からの 80 番の受信があるか（`pulumi refresh` → `pulumi up`）、Caddy・oauth2-proxy のコンテナ（`docker ps`）。起動の直後は数十秒かかる（エラーはキャッシュしないので開き直す） |
| 素の 403（接続が閉じる）・Windows エージェントが認証の失敗で送信を止めた | Caddy の合言葉の不一致（合言葉を動いている間に入れ替えた等） | 止めて起動し直す（aws-stop の stop-all → STOPPED を確認 → aws-view。起動のたびに boot が SSM を読み直し、コンテナを作り直す。動いているコンテナは boot をやり直すだけでは作り直されない）。エージェントは本人が送信を再開する |
| 421 | Host が公開 URL と違う（distribution を作り直した後など） | `pulumi up` で `control/site.json` を更新 → 止めて起動し直す（boot が site.json を読み直す） |
| ログインが繰り返す・callback のエラー | Cognito の App client の callback が `site_url` + `/oauth2/callback` か（`pulumi stack output site_url`） | `pulumi up`（distribution の後に Cognito を更新する）。ブラウザの Cookie（`__Host-jrabot`）を消して開き直す |
| ログインできたが 403 | 本人のメールか（`ownerEmail` と Cognito の利用者のメールの一致）、`app_user` の行 | ホストの boot と復元の直後に `INSERT IGNORE` で作る（既存の行は変えない）。既存の行が無効（enabled=0）・VIEWER なら、本人の判断で DB を直す（自動では変えない） |
| Cognito でログインできない | 本人のメールか・MFA | 管理者がコンソールでパスワードの再設定 |
| 公開 URL が変わった | distribution を作り直した（Pulumi の差分で `replace`） | 新しい `site_url` をブックマーク・Windows エージェントの `server.base_url` に。Cognito の callback は Pulumi が更新する |
| EC2 の置換えが必要（壊れた・AZ の変更等） | — | **自動では行わない（未対応・手作業）**: VPC origin のインスタンスの変更は provider でその場の更新（`UpdateVpcOrigin`）になり、distribution が使っている間は失敗し得る（`CannotUpdateEntityWhileInUse`）。下の「インスタンスの置換え（手順の案）」を、実施の前に本人が確認する（実データ） |
| 停止が clean=false | Discord・status の last_stop | 次の起動後に aws-backup で取り直す |
| 「停止し忘れ」 | status の holds・auto_stop_at | aws-stop（stop-all）。制御が動かない場合もホストが 30 時間で自分で止まる |
| アラームのメール（制御のエラー・定期実行が来ない） | CloudWatch のロググループ `/aws/lambda/<prefix>-controller` | 原因（権限・状態の破損）を直す。止まらない EC2 はコンソールで停止 |
| 開催の計画が無い・古いの通知 | status | aws-view で一度起動して計画を更新する（NORMAL の間 6 時間ごとに書き出す）か、aws-raceday add |
| ネットワークの範囲の違い（boot の失敗） | `docker network inspect jrabot` | 全コンテナを止めて `docker network rm jrabot` → `systemctl restart jrabot-boot` |
| モデルの鍵の入替え | — | 新しい署名鍵を SSM に置く（旧い鍵で署名したモデルは再学習・再署名）。複数の検証鍵の併用は未対応（必要になったら web の CONTRACTS §5.1 に合わせて追加） |

**インスタンスの置換え（手順の案。実環境で未確認。公式「Update a VPC origin」に沿う）**:
1. aws-backup → aws-stop（stop-all）→ STOPPED を確認。Scheduler を一時的に止める（`aws scheduler update-schedule … --state DISABLED`。止めている間『定期実行が来ない』のアラームが届く）。
2. **distribution から VPC origin を外す**（コンソール）: 既定の動作の origin を S3 の案内のページ（`offline`）に変える → Origins タブで `host`（VPC origin）を削除（関連付けの解除）→ 配布の完了を待つ。
3. データ:
   - **同じ AZ**: データの EBS を旧インスタンスから外す（停止中）。
   - **AZ を変える**: データの EBS は AZ に固定され、Pulumi では `protect`・`retainOnDelete`。新しい AZ には、スナップショットから新しいボリュームを作るか、新しい空のボリュームに S3 のバックアップを §8 で戻す。Pulumi の state は `pulumi import`（新しいボリューム）と `pulumi state delete`（旧いボリューム。実物は消さない）で合わせる。設定の `availabilityZoneId` を変える。
4. 旧インスタンスの削除保護を外す（`aws ec2 modify-instance-attribute --no-disable-api-termination`）→ `pulumi up --replace '<インスタンスの URN>'`（`pulumi stack --show-urns` で確認。新しいインスタンスは作成と同時に起動する。VPC origin はその場の更新〔distribution から外してあるので可〕→ 管理 SG の規則 → distribution の `host` の origin が Pulumi の定義どおりに戻る）。
5. `pulumi refresh` → `pulumi preview` が差分なし → Scheduler を戻す（`--state ENABLED`）→ aws-view で確認（V-3・V-5）。

**合言葉（`X-Origin-Verify`）の入替え**（漏れた疑いがあるとき。**EC2 を止めた状態で・開催日には行わない**）: `pulumi stack --show-urns | grep origin-verify` で RandomPassword の URN を確かめ、`pulumi up --replace '<URN>'`（SSM の値と distribution のヘッダが同時に変わる。配布の完了を待つ）→ 次の起動の boot で Caddy が新しい値を読む。動いている間に行うと、作り直すまで 403 になり、**Windows エージェントは認証の失敗として送信を止める**（本人が再開するまで）。

## 10. 費用の確認と、残りやすい有料リソース
- 停止中も課金されるもの: EBS（ルート 12 GB + データ 16 GB）・スナップショット・S3・ECR・（ごく少額）Lambda・Scheduler・CloudWatch のアラーム。**EC2 と公開 IPv4 は停止中は課金されない**（Elastic IP を作らない）。CloudFront は従量（停止中は案内のページの要求だけ。ほぼ $0）。**Route 53・ドメインの費用は無い**。
- 片付けるときに残りやすいもの: データ用 EBS（`retainOnDelete`）・Cognito（削除保護）・S3（中身があると消えない）・スナップショット・ECR のイメージ・CloudWatch のロググループ・CloudFront の distribution（無効にしてから削除。数分かかる）・VPC origin。削除は本人の判断（実データの削除）。
- Budgets は**通知だけ**（止まらない）。

## 11. 未実施（実環境が必要）
`pulumi preview/up`、Lambda の実行、EC2 の起動と user data、**CloudFront の distribution・VPC origin の作成と到達（V-1: IGW へ経路のあるサブネットでの VPC origin。AWS の文書の前提はプライベートサブネット）・作成の順序と途中の失敗（V-2）・停止/起動の後の 503 の案内と復帰、ingest の 503 の `X-Ops-Mode`・`Retry-After`・4xx の JSON が CloudFront を通っても同じこと（V-3）・管理 SG の名前の検索（V-4）・Cognito のログイン/ログアウト/MFA の往復と dashboard が見る Host（V-5）・EC2 への直接の接続の拒否（V-6）**、SSM Run Command、ECR への push・pull、arm64 の実機での JVM の起動とメモリ、S3 の条件付き書込みの実挙動（偽の S3 で試験）、Windows エージェントとの接続（CloudFront 経由の HMAC の署名・gzip の本文）、GCP からの実データの移行。初回の構築のときに §1 の順で確かめ、結果を PROGRESS に記録する。V-1 が通らないときの代替と費用は `AWS_ARCHITECTURE.md` §10。
