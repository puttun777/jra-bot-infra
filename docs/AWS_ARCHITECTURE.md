# AWS 構成（GCP からの移行先。2026-11-13・2026-11-17 改訂。I-042〜I-047・I-050・web D-280〜D-288）

**状態: 定義・試験まで（AWS には何も作っていない）**。`pulumi up`・課金リソースの作成・実データの移行は本人の承認後（CLAUDE.md 絶対ルール 3）。
運用の手順は `AWS_OPERATIONS.md`、費用は `CLOUD_COSTS.md` §13（§12 は独自ドメインを使っていたときの旧版）、アプリ側の契約は web の `docs/CONTRACTS.md`（0.4.20。入口は §11.4）。

**2026-11-17 の方針変更（I-050・web D-288）: 独自ドメインを取得しない**。公開 URL は CloudFront の標準の `https://<distribution>.cloudfront.net`（既定の証明書）。Route 53・Let's Encrypt・制御の DNS の更新は削除した。

## 1. 方針と全体像
利用者は本人 1 名・私的利用（web REQUIREMENTS §0）。**普段は EC2 を止めておき、開催日と、本人が見たいときだけ起動する**（月 100 時間前後）。
固定費を作る NAT Gateway・ALB・RDS・Elastic IP は使わない。

```
[本人のスマホ/PC・Windows 取得エージェント]
   │ HTTPS（CloudFront の標準のドメインと証明書。http は https へ転送）
   ▼
CloudFront（キャッシュしない: CachingDisabled + AllViewer。エラーもキャッシュしない。502/504 → 503 の案内のページ〔S3・OAC〕）
   │ VPC origin（AWS の網の中。EC2 の private DNS の 80 番。合言葉のヘッダ X-Origin-Verify を付ける）
   ▼
EC2 t4g.small（東京・IGW へ経路のあるサブネット・公開 IPv4 は外向きの通信のためだけ。SG の受信は VPC origin の管理 SG からの 80 番だけ）
   ├ Caddy（HTTP。合言葉・Host の検査、識別のヘッダの除去、/internal は 404、/v1/agent/* → ingest、他 → oauth2-proxy）
   ├ oauth2-proxy（Cognito の OIDC・MFA。本人のメールだけ。ID トークンを Authorization で dashboard へ）
   ├ dashboard / ingest（Kotlin。内部ネットワークだけ）
   ├ MySQL 8.4（公開しない。データはデータ用 EBS /data）
   ├ bot-run / bot のタスク / batch / ml-train / db-migration（その都度起動するコンテナ）
   └ jrabot-host（運用エージェント。systemd の 1 分ごとの tick・起動・排出・バックアップ・deploy）

[GitHub Actions（infra。手動実行・スマホ可）] ──OIDC──> IAM ロール（lambda:InvokeFunction 等だけ）
   └──> Lambda「制御」（VPC に接続しない） <── EventBridge Scheduler（5 分ごと）
          ├ S3 ops-state（運用状態の正本・ホストの報告・開催予定。条件付き書込みで CAS）
          ├ EC2 の起動・停止 / CloudFront 経由の準備完了の確認（GET <site_url>/_jrabot/health）/ ビーコンの署名（S3 beacon）
          └ Discord 通知（失敗・停止し忘れ）
[Windows 取得エージェント] ── ビーコン（S3 の公開オブジェクト・Ed25519 署名）を読む → NORMAL のときだけ <site_url>/v1/agent/* へ送る
```

**独自ドメインなしで使える仕組み**: CloudFront の distribution を作ると `d<英数字>.cloudfront.net` の名前と、それに有効な証明書が AWS から付く。名前は distribution に付くので、EC2 を止めても・起動のたびに IP が変わっても変わらない（origin は IP ではなく VPC origin = EC2 のインスタンスの ARN で指定する）。DNS の更新・証明書の取得・更新は不要。URL は Pulumi の出力 `site_url`。

## 2. 採用した AWS サービスと理由
| 用途 | 採用 | 理由・代替案 |
|---|---|---|
| 計算 | EC2 **t4g.small**（arm64・2 vCPU・2 GiB）+ swap 1 GiB、`cpuCredits=unlimited` | 実測（web HOSTING_OPTIONS・2026-11-13）で開催日の同時稼働のピーク約 1.4 GiB（MySQL 177・dashboard 212・ingest 212・bot-run 203 MiB + OS）。t4g.micro（1 GiB）は不足。t3.small（x86）は 26% 高い。arm64 は CI でネイティブにビルド・起動を確認（web images-arm64）。重い処理（batch・ML）は開催日と同時に動かさない（§5） |
| DB | EC2 上の MySQL 8.4（コンテナ）+ **データ用 EBS gp3 16 GB**（`protect`・`retainOnDelete`） | RDS は停止中もストレージ・バックアップ課金があり、7 日で自動起動する。Aurora Serverless v2 は最低 ACU の費用。アプリの MySQL・Doma・Flyway はそのまま |
| 状態・成果物 | S3（ops-state・beacon・models・backups・site〔停止中の案内のページ〕） | GCS の置換え。運用状態は条件付き書込み（If-Match/If-None-Match）で CAS |
| 起動・停止・状態 | Lambda（Node 24・arm64・**VPC なし**）+ EventBridge Scheduler（5 分ごと） | Cloud Scheduler・Cloud Run Jobs（ops）の置換え。VPC に入れないので NAT 不要 |
| 公開 URL・HTTPS | **CloudFront の標準のドメイン**（既定の証明書・従量課金。flat-rate の料金プランは使わない: VPC origin は Business〔$200/月〕以上だけ） | 独自ドメインを持たない（本人の方針）。EC2 の IP が変わっても URL が変わらない。キャッシュしない（§6.2）。PriceClass_200（日本を含む） |
| CloudFront → EC2 | **VPC origin**（EC2 を直接の origin に。追加料金なし） | EC2 に公開のポートを開けない（SG は VPC origin の管理 SG からだけ）。ALB（月 $17.7〜）・NAT を使わない。代替案と費用は §10 |
| 本人の認証 | Cognito ユーザープール（**Lite**・管理者だけが作成・MFA 必須）+ oauth2-proxy | IAP の置換え。ALB を使わない。アプリは ID トークンの署名を JWKS で検証（web cloud-aws `CognitoIdTokenVerifier`） |
| 秘密 | SSM Parameter Store の SecureString（標準・AWS 管理キー） | Secret Manager の置換え。Secrets Manager は 1 件 $0.40/月のため不採用 |
| イメージ | ECR（`IMMUTABLE`・最新 6 世代） | Artifact Registry の置換え |
| 管理の経路 | SSM Run Command（GitHub Actions から）・SSM Session Manager | SSH・鍵・22 番を使わない |
| デプロイ | GitHub Actions の OIDC → IAM ロール | 長期キーを持たない |
| ログ | コンテナは json-file（10 MB×3）、Lambda は CloudWatch Logs（14 日） | Cloud Logging の置換え。ホストのログ・CloudFront のログを CloudWatch に送らない（費用） |
| 予算 | AWS Budgets（通知だけ。**強制停止ではない**） | 停止し忘れの安全網は制御の `maxRunningHours`（§4）とホストの稼働の上限（§5） |
| 制御の監視 | CloudWatch のアラーム 2 個（Lambda のエラーが 1 時間に 3 回以上・定期実行が 1 時間来ない）→ SNS → メール | 制御が動かないと自動停止も通知も止まるため。購読の確認は本人（U9） |
| バックアップ | mysqldump（整合）→ S3（SHA-256 確認・バージョニング・保持 35 日）+ EBS スナップショット（DLM・週 1・2 世代） | Cloud SQL の自動バックアップの置換え |

不採用: 独自ドメイン・Route 53・ACM・Let's Encrypt（I-050 で削除）、NAT Gateway・ALB・RDS・Elastic IP（停止中も課金）・AWS WAF（月 $5〜 + ルール。本人だけの利用で、アプリの認証が必須のため）・CloudFront の flat-rate の料金プラン（Free・Pro は VPC origin が使えず、使える Business は $200/月）・Secrets Manager・CloudWatch Agent・ECS/Fargate（常駐の費用）・Python。

## 3. 運用モードと起動目的（hold）
- 運用状態（web CONTRACTS §7 の ops-state）は S3 `state/ops-state.json`。GCP と同じ `mode`（STOPPED・STARTING・NORMAL・STOPPING）に、AWS の節 `aws`（起動目的の一覧・停止の記録など）と、アプリに渡す **`workloads {raceday, batch}`**（web D-282）を足した。
- **起動目的（hold）**: `VIEW`（閲覧）・`RACEDAY`（開催日）・`BATCH`（重い処理）・`MAINTENANCE`（deploy）。それぞれ期限を持つ。hold が 1 つでもあれば起動し、全部無くなれば停止する。
  - `VIEW`: 本人の手動。同じ要求の再実行は「今から N 分」に延長（短くしない）。`view-end` は、その実行より後に延長された VIEW は外さない（古い停止の要求で、新しい閲覧を止めない）。
  - `RACEDAY`（同時に 3 日まで。発走時刻がその日〔JST〕の外なら既定の時刻を使うので、窓は 1 日 + 前後の余裕に収まる）: アプリが JRA の開催予定から作る計画（`--task=calendar-plan` → S3 `control/calendar-plan.json`。web D-283）と手動の登録から、**最初の発走の 240 分前〜最後の発走の 150 分後**に自動で作る（設定 `racedayLeadMinutes`・`racedayTailMinutes`）。ホストが「その日の処理が終わった」と報告したら外す（終了を待たずに停止しない・終わったら早めに止める）。
  - `BATCH`: 開催日の処理中は拒否（開催日が優先・メモリ）。
- **workloads**: `raceday` は RACEDAY の hold があり NORMAL/STARTING のときだけ true、`batch` は BATCH の hold があり RACEDAY が無いときだけ true。アプリの bot の Job は `OPS_WORKLOAD_GATE=required` で、**raceday=false なら bot-run・通知のタスクを起動しない**（閲覧だけの起動で Discord に通知しない）。
- **ビーコン**（Windows エージェント向け。web CONTRACTS §7.2）: NORMAL は「RACEDAY で、ホストが ingest の準備完了を報告している」ときだけ。閲覧だけの起動ではエージェントに送らせない。
- 停止の判断は制御だけが行い、EC2 の停止（電源）とアプリの STOPPED を混同しない: 制御が STOPPING にする → ホストが排出（受付停止 → 実行中の処理の終了 → バックアップ → MySQL の正常終了 → 電源断）→ 制御が EC2 の停止を確認して STOPPED。排出が 25 分で終わらなければ `StopInstances`、さらに 10 分で強制停止（記録と通知）。
- **公開 URL を開いただけでは起動しない**: CloudFront・Caddy・アプリのどこにも起動の経路は無い（起動は GitHub Actions の `aws-view`〔OIDC・本人だけ〕か、開催日の自動）。停止中に URL を開くと 503 の案内のページ（§6.2）。

## 4. 制御（Lambda）の状態機械
`ops/src/aws/controller.ts`（純粋な関数 `applyRequest`・`reconcile`）と `lambda.ts`（CAS で最大 4 回やり直す。副作用は状態を書けた後だけ・冪等）。
| 今 | 条件 | 次 | 副作用 |
|---|---|---|---|
| STOPPED | hold あり | STARTING | StartInstances |
| STOPPED | EC2 が動いている（制御を通さない起動） | STOPPING | 通知 |
| STARTING | ホストが起動の要求の後に READY（MySQL・dashboard）を報告し、**CloudFront 経由で `/_jrabot/health` が 200 ok**（Lambda が `SITE_URL` に GET。届かなければ STARTING のまま） | NORMAL | （DNS の更新は無い: I-050） |
| STARTING | 20 分を超えた | （そのまま） | 通知（EC2 の状態と CloudFront 経由の確認の結果を書く。起動の要求は続ける） |
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
- **定期実行の失敗**（4 回の競合・起動・停止・ビーコン・通知の失敗）は例外にする（アラーム）。送れなかった一度だけの警告は印を外して次の実行で送り直す。再実行（Re-run）の要求は元の時刻を使わない。ホストの報告が壊れていたら「無い」として扱う。
- 要求の時刻は GitHub の実行の作成時刻（runner の待ちで閲覧の延長と終了の順序が逆転しない）。
- **CloudFront 経由の確認**（`probeSite`）: Lambda の `SITE_URL`（必須。`https://d<英数字>.cloudfront.net` の形だけ）に、リダイレクトを追わず 5 秒で打ち切って GET。200 で本文が `ok` のときだけ準備完了。届かない・確かめられないときは NORMAL にしない（例外にはしない。起動の時間切れの通知で分かる）。
- **制御が生きている印**: EC2 が動いている間は `aws.last_alive_at` を 1 時間ごとに書く（状態が変わらなくても運用状態が書かれる）。ホストはこれが 3 時間以上書かれていないときだけ「制御が止まっている」とみなす（§5）。
- **初回の構築との競合**: Scheduler（定期実行）は Pulumi で distribution・`control/site.json`・SG の規則の**後**に作る（`dependsOn`）。VPC origin の作成には EC2 が動いている必要があり、作成の途中で制御が EC2 を止めることはない（§11 の V-2）。

## 5. ホスト（EC2）
- Amazon Linux 2023（arm64）。user data（初回だけ）: Docker・ECR の資格情報ヘルパー・Node 24（SHA-256 を確認）・データ用 EBS の初期化（**ファイルシステムが無いときだけ**）・swap・systemd。
- 運用エージェント `jrabot-host`（`ops/src/aws/hostctl.ts` を esbuild で 1 ファイルに。S3 の `host/` から起動のたびに SHA-256 を確かめて取得）。
  - `boot`: SSM の秘密（origin の合言葉を含む）を tmpfs（/run/jrabot）へ → S3 の `control/site.json`（公開のホスト名・Cognito。形式を検査）を /run/jrabot へ → DB の利用者 → `db-migration --mode=validate`（**未適用があれば起動しない**。適用は deploy だけ）→ **本人の利用者の行**（`tenant(1)` と `app_user(本人のメール, ADMIN)` を `INSERT IGNORE`。既存の行は変えない）。
  - `tick`（1 分ごと）: 判断は `host.ts` の `planHost`（純粋）。閲覧だけなら MySQL・dashboard・oauth2-proxy・Caddy だけ。開催日は ingest と calendar-check（5 分ごと）→ spool（`JOB_LAUNCHER=spool`。web D-283）で bot-run。STOPPING を見たら排出。
  - boot・tick・deploy・backup・restore は `flock` で同時に動かさない（run-batch は長いので除外。排出は tick が止める）。
  - `/data`（データの EBS）がマウントされていなければ起動しない（空の DB を作らない）。spool の起動は 1 回の実行で 1 つまで。照合（reconcile）が失敗した開催日は終わりにしない（15 分ごとに再試行）。
  - **ホストの稼働の上限**（`max_uptime_hours` 既定 30 時間）: 制御が止まっているように見える（運用状態が 3 時間以上書かれていない。動いている間は 1 時間ごとに書かれる）ときだけ、自分で排出して止まる（制御が動いていれば停止は制御に任せる）。
- コンテナ（`services.ts`）: `--cap-drop ALL`・`no-new-privileges`・読取り専用（アプリ・Caddy）・メモリ上限（スワップなし）・ログの上限・digest で固定。公開ポートは **Caddy の 80 だけ**（443 は使わない: TLS は CloudFront で終わる）と 127.0.0.1 だけ（MySQL はどこにも公開しない）。
- **IMDS の遮断**: インスタンスのロールはアプリ（S3 の運用状態・モデル）のためにコンテナから使えるようにしている（ホップ 2）。インターネットに面する Caddy・oauth2-proxy と MySQL は IMDS に届かない固定 IP（172.30.0.128/25）で動かし、`DOCKER-USER` の規則で 169.254.169.254 への通信を落とす。**残るリスク**: アプリのコンテナ（dashboard・ingest・bot）が乗っ取られると、インスタンスのロールの権限に届く: SSM の秘密の読取り（ビーコンの署名鍵は明示的に拒否）、ホストの報告・開催の計画の偽造（早すぎる停止・余計な起動 = 費用）、版のファイルの書換え。版のファイルについては、ホストが**このアカウントの ECR の jra-bot/<名前> と許可したサードパーティの出どころ（tag + digest）のイメージだけ**を動かす（`assertTrustedImages`）ので、別のイメージは動かせない（古い版への差し替えは残る）。根本の対策（アプリの資格情報をホストのロールから分ける）は後続の課題。
- メモリ（上限の合計）: 常駐（MySQL 448・dashboard 288・ingest 288・oauth2-proxy 64・Caddy 64 MiB）+ bot-run 384 + タスク 256 = 1,792 MiB ≤ 1,810（試験 `aws-services`）。batch・ml-train（1,024 MiB）は開催日には動かさない。
- **外向きの通信**（ECR・S3・SSM・Cognito の JWKS・Discord・Amazon Linux のリポジトリ）: サブネットの経路は IGW、EC2 に公開 IPv4（起動中だけ $0.005/時）。NAT・VPC エンドポイントは使わない（§10）。受信は SG で VPC origin の管理 SG からの 80 番だけなので、公開 IPv4 に直接つないでも届かない。

## 6. 認証・認可（本人だけ）
### 6.1 入口ごとの認証
| 入口 | 認証 | 備考 |
|---|---|---|
| 画面 `https://<distribution>.cloudfront.net/` | Cognito（パスワード + TOTP の MFA）→ oauth2-proxy（`--authenticated-emails-file` で本人のメールだけ）→ dashboard が **ID トークンの署名・iss・aud・token_use・exp・email_verified を検証し、`ALLOWED_USERS`・`app_user`・`ADMIN_USERS` で本人だけを通す** | Cognito の自己登録は無効（管理者だけが作る）。Cognito にログインできても本人以外は oauth2-proxy と dashboard の両方で拒否（web の試験 `DashboardAwsPersonAuthTest`）。Cookie は `__Host-jrabot`・Secure・HttpOnly。callback は `<site_url>/oauth2/callback`、logout は `/logout` → oauth2-proxy の sign_out → Cognito の `/logout` → `<site_url>/`（oauth2-proxy の `--whitelist-domain` は Cognito のドメインだけ） |
| `/v1/agent/*` | エージェントのトークン + HMAC（ingest。web CONTRACTS §3.3） | oauth2-proxy・Cognito を通さない（機械。人のログイン画面を返さない）。閲覧だけの起動では ingest が動いていない（502 → 503 の案内。エージェントは運用モード不明として待つ） |
| `/internal/*` | Caddy で 404（外から届かない）。内部は `INTERNAL_OPS_TOKEN_FILE`（起動ごとに作る乱数・定数時間比較） | |
| 起動・停止・状態・deploy | GitHub Actions（infra・`environment: ops`・main だけ）→ OIDC（`sub = repo:<owner>/jra-bot-infra:environment:ops`）→ IAM ロール | ロールの権限: Lambda の呼出し・SSM Run Command（このインスタンスと**専用のドキュメント `<prefix>-host-command` だけ**: `jrabot-host deploy|backup|run-batch`、引数は英数字と `=.,_:/ -` だけ。任意のシェルは送れない）・`control/release-candidate.json` の書込み・SSM の秘密の作成（`PutParameter` だけ。値を読む権限は無い） |
| web のイメージの push | `environment: release` の OIDC → ECR の push だけ（`enableWebPush=true` の後） | |
| 管理者 | SSM Session Manager（コンソール・CloudShell） | SSH なし・22 番を開けない |

### 6.2 CloudFront の設定（キャッシュ・転送）
- 既定の動作（`*`・origin = EC2）: 管理キャッシュポリシー **CachingDisabled**（`4135ea2d-…`。キャッシュしない・キャッシュキーなし）、管理 origin request ポリシー **AllViewer**（`216adef6-…`。ビューアの全ヘッダ〔Host・Cookie・Authorization〕・全 Cookie・全クエリを転送。CloudFront は既定では Authorization を消すが、Managed-AllViewer を使えば転送する: 公式「Configure CloudFront to forward the Authorization header」。今の経路は閲覧者の Authorization に頼らない〔人は Cookie、エージェントは X-Signature 等〕）、メソッドは GET・HEAD・OPTIONS・PUT・POST・PATCH・DELETE、`redirect-to-https`、圧縮しない（Caddy が gzip）。Set-Cookie・ログインの応答はキャッシュに入らないので他人に配られない。
- エラーの応答: 400・403・404・405・414・416・500・501・503 は **TTL 0**（キャッシュしない・ページを指定しない = origin の応答をそのまま返す〔公式「Control how long CloudFront caches errors」〕。アプリ・ingest の 503 + `X-Ops-Mode`・`Retry-After`・4xx の JSON がそのまま届くことは実環境で確かめる: §11 V-3）。**502・504（EC2 が止まっている・起動中・Caddy の上流が未起動）は 503 と S3 の案内のページ**（TTL 0。案内のページにはリポジトリ名・手順を書かない）。起動の後に古いエラーが残らない。
- `/_offline/*`（案内のページ）: origin = S3（OAC・SigV4・常に署名。バケットは公開しない。ポリシーは distribution の ARN の条件付きで `_offline/*` の読取りだけ）。
- **CloudFront → EC2**: VPC origin（http-only・80 番・接続 5 秒×2 回〔起動直後の遅い接続で「停止中」にしない。停止中の案内までは最大 約 10 秒〕・読取り 60 秒）。カスタムヘッダ `X-Origin-Verify: <48 文字の乱数>`（Pulumi の `random` で構築時に作り、SSM の SecureString にも置く。ホストは boot で読んで Caddy に渡す。閲覧者が同名のヘッダを付けても CloudFront のカスタムヘッダが上書きする）。

### 6.3 CloudFront から EC2 までの保護（HTTPS はブラウザ → CloudFront まで）
ブラウザから CloudFront までが HTTPS であることと、CloudFront から EC2 までの保護は別に満たす:
1. **到達の制限**: EC2 の SG の受信は 1 つだけ（`CloudFront-VPCOrigins-Service-SG*` からの TCP 80）。インターネット・同じ VPC の他・SSH は届かない。公開 IPv4 は外向き用（受信の規則が無い）。VPC origin は AWS の網の中を通る（公開のインターネットを通らない）。
2. **合言葉のヘッダ**: VPC origin の管理 SG は「このアカウントの CloudFront の distribution」を通すため、同じアカウントに別の distribution を作った場合などに備え、Caddy が `X-Origin-Verify` を検査する（無い・違う・前方一致は 403 で接続を閉じる）。合言葉は上流へ渡さない。
3. **Host の検査**: `Host` が公開のホスト名（`control/site.json`）でなければ 421。dashboard の CSRF の Origin == Host の検査と、Cookie・戻り先の URL が公開 URL と一致する。
3b. **パスの検査**: Caddy の経路の一致は整えた後のパス（`..`・`%2e` の解決後）で行い、上流へは元のパスを渡す。そのずれで `/internal` の遮断を迂回させないよう、パスに `;`・`\`・`/./`・`/../`・`%2e`・`%2f`・`%5c`・`%3b`・`%25`・`%00` を含む要求は 400（クエリは対象外）。
4. **識別のヘッダを信じない**: Caddy が `X-Forwarded-*`（User・Email・Preferred-Username・Groups・Access-Token・Uri を含む）・`X-Auth-Request-*`（Redirect を含む）・`Forwarded`・`X-Real-Ip`・IAP のヘッダを捨て、`X-Forwarded-Proto: https`・`X-Forwarded-Host` を付け直す（oauth2-proxy は `--reverse-proxy` で X-Auth-Request-Redirect・X-Forwarded-Uri を戻り先に使うため）。oauth2-proxy は `--pass-host-header=true`（Host を変えない）。dashboard は `Authorization` の ID トークンの**署名**を検証する（ヘッダの名前・値だけでは入れない）。
5. **アプリの認証**: 上の 1〜4 を全部通っても、Cognito の ID トークンと本人の許可が無ければ 401/403。
- **CloudFront → EC2 は暗号化しない**（HTTP）。AWS の網の中で、上の 1〜4 で守る。暗号化が必要なら origin に自己署名の証明書（VPC origin は origin の証明書の検証が必要で、公開の CA の証明書には名前が要る → 独自ドメインが要る）または ALB が必要で、費用・ドメインの要件に合わない（§10）。
- 試験: Caddy の実物での結合試験（infra `ops/it/caddy-edge.mjs`・CI の `aws-edge`。合成）、Pulumi の mock の試験（SG・CloudFront の設定）、web の HTTP の試験（認証・認可・CSRF）。**実 CloudFront・実 VPC origin では未検証**（§11）。

## 7. データ保護
- データ用 EBS は Pulumi で `protect`・`retainOnDelete`、EC2 は `disableApiTermination`、user data はファイルシステムがあれば初期化しない。コンテナの作り直し・EC2 の停止で消えない。
- バックアップ: 停止のたび・deploy の前・restore の前・手動（`aws-backup`）に mysqldump `--single-transaction`（整合）→ gzip → S3（`IfNoneMatch` で上書きしない・SHA-256 を記録して読み直して確認）。**失敗を成功と報告しない**（ホストの報告 → 制御の `last_stop.backup_ok` → 通知）。保持 35 日（ライフサイクル）・旧版 7 日。ホストのロールは削除できない。
- 復元: `jrabot-host restore --key … --confirm RESTORE-<日付>`（**保守の起動目的が 90 分以上残っている NORMAL** のときだけ。開催日・重い処理・ジョブの最中は拒否。直前に現状のバックアップ → dump の最後の行を確認 → DB を作り直して流し込む。流し込みの失敗は直前のバックアップのキーを表示）。**流し込みの直後に本人の利用者の行を `INSERT IGNORE`**（戻した dump に本人の行が無くても 403 にならない。既存の行は変えない）。合成データで dump → 別の MySQL へ復元 → 全表のチェックサム一致と、復元の後の本人の行（作成・再実行・既存の行を変えない）を CI で確認（`ops/it/backup-restore.mjs`。Flyway の実スキーマ 38 表でも確認）。
- 実データ・秘密・学習済みモデルを Git に入れない。**COMP-4 の回答までは実データを AWS に入れない**（web UNRESOLVED）。

## 8. 版数（固定）
@pulumi/aws 7.52.1、@pulumi/random 4.21.6、@aws-sdk/client-* 3.1160.0、esbuild 0.28.2、AWS SDK for Java 2.57.5（web）、Node v24.22.2（SHA-256 固定）、mysql:8.4.11・caddy:2.11.6（digest 固定）、oauth2-proxy v7.15.3（digest は deploy の前に本人が確認して `hostImages` に入れる: `AWS_OPERATIONS.md` U5）。

## 9. GCP の定義との関係
`terraform/`・`pulumi/`（GCP）と GCP 向けの workflow（ops-start・ops-stop・ops-status・deploy）は**切替が終わるまで残す**（切戻し用）。AWS の定義は `pulumi-aws/`、運用は `aws-*` の workflow。同じ時期に両方で bot・Scheduler を動かさない手順は `AWS_OPERATIONS.md` §7。

## 10. CloudFront から EC2 への接続の比較（2026-11-17。東京・税抜・公式の価格表〔2026-11-01 有効〕）
| 案 | 構成 | 追加の費用（月） | 判断 |
|---|---|---|---|
| **採用: VPC origin + IGW 経路のサブネット** | EC2 を VPC origin に。外向きは EC2 の公開 IPv4（受信の規則なし） | **$0**（VPC origin は無料。EC2 → CloudFront の転送も無料。IPv4 は起動中だけで従来どおり） | 最安。受信は管理 SG だけ。**AWS の文書の前提は「プライベートサブネット」**で、IGW 経路のサブネットでの動作は初回の構築で確かめる（§11 V-1） |
| A: VPC origin + プライベートサブネット + NAT Gateway | 外向きは NAT GW | 常時 $45.3（$0.062/時）+ $0.062/GB。起動中だけ作る場合 100 時間 $6.2（作成・削除の自動化が必要） | 固定費が大きい。V-1 が通らないときの代替（起動中だけ作る形） |
| B: プライベートサブネット + VPC エンドポイント | S3 はゲートウェイ（無料）、ECR api・dkr・SSM・ssmmessages・ec2messages・STS はインターフェイス | 6 個 × $0.014/時 = 常時 $61.3（+$0.01/GB） | Discord・Cognito の JWKS はインターネットが要るので単独では成り立たない |
| C: プライベートサブネット + NAT インスタンス | t4g.nano を EC2 と一緒に起動・停止 | 約 $0.0104/時（t4g.nano 約 $0.0054〔推定。t4g は大きさに比例〕+ IPv4 $0.005）→ 100 時間 $1.0 + EBS 8 GB $0.77 | 安いが、管理する EC2 が 2 台になる（更新・起動の順序・故障）。V-1 が通らないときの第一の代替 |
| D: 公開の origin（EC2 の公開 DNS・CloudFront の prefix list） | VPC origin なし | $0 | 起動のたびに公開 DNS が変わる → distribution の更新（数分〜15 分）が毎回要る。Elastic IP で固定すると $3.65。origin までインターネットを通る → 不採用 |
| E: ALB + VPC origin | ALB を origin に | $17.7（$0.0243/時）+ LCU | 固定費 → 不採用 |
| F: CloudFront の flat-rate（Free・Pro・Business） | — | Free・Pro は VPC origin 不可、Business は $200 | 不採用（従量課金で使う） |
| G: プライベートサブネット + egress-only IGW（IPv6 の外向き） | IPv6 だけで外へ | $0（未確認） | ECR・SSM・S3 の dual-stack の端点、Discord・nodejs.org・AL2023 のリポジトリが IPv6 で届くかの確認が要る。V-1 が通らないときの候補 |

## 11. 残るリスクと、初回の構築で確かめること（実 AWS が必要。mock・CI では確かめていない）
- **V-1（IGW 経路のサブネットでの VPC origin）**: AWS の文書の前提はプライベートサブネット。IGW へ経路のあるサブネット（EC2 に公開 IPv4）で VPC origin が作れて、届くかを初回の構築で確かめる（公式の「Create a VPC origin (existing distribution)」は、VPC origin に切り替えた後に「サブネットをプライベートにして公開のアクセスを外す」手順で、公開のサブネットでも作れる前提に読める。ただし確認は必要）。だめなら §10 の C（NAT インスタンス）・A（起動中だけの NAT GW）・G（IPv6）へ（Pulumi の変更が必要。費用は §10）。
- **V-2（作成の順序）**: VPC origin の作成には EC2 が Active（running）である必要がある。Pulumi は IGW・経路表の関連付け → EC2 → VPC origin（待ちは 30 分まで）→ 管理 SG の参照 → SG の規則 → distribution → Cognito の client → site.json → Lambda → Scheduler の順に作る（循環なし）。Scheduler が最後なので、作成の途中で制御が EC2 を止めない（途中で失敗したときの扱いは `AWS_OPERATIONS.md` §1.3）。
- **インスタンスの置換えは未対応（手作業）**: VPC origin の endpoint（インスタンスの ARN）の変更は、provider ではその場の更新（`UpdateVpcOrigin`）になり、distribution が使っている間は失敗し得る（API の `CannotUpdateEntityWhileInUse`。公式の手順も先に distribution から外す）。EC2 の削除保護とデータの EBS の付け替えも要る。AZ の変更などでインスタンスを置き換えるときは `AWS_OPERATIONS.md` §9 の手作業の手順で行う（自動の置換えは作らない: レビュー B1）。
- **V-3（停止・起動の後・エラーの応答）**: EC2 を止めても VPC origin はインスタンスの ARN で指すので作り直さない想定。止めている間は 502/504 → 503 の案内、起動後に通常に戻ること（エラーをキャッシュしない）を確かめる。あわせて、CloudFront 経由でも ingest の 503 の `X-Ops-Mode`・`Retry-After` と 4xx の JSON の本文がそのまま届くこと（エージェントの分類が変わらない）。
- **V-4（管理 SG の名前）**: Pulumi は VPC の中の `CloudFront-VPCOrigins-Service-SG*` を名前で探す。AWS が名前の形を変えたら構築が止まる（安全側）。
- **V-5（Cognito のログイン）**: CloudFront の URL での callback・logout・MFA・ログインの繰り返しが起きないこと。dashboard が見る `Host` が `d*.cloudfront.net` であること（管理の POST が CSRF で 403 にならない）。
- **V-6（直接の接続の拒否）**: EC2 の公開 IPv4 の 80 番に届かないこと（SG）、合言葉の無い要求が 403 になること。
- 合言葉（`X-Origin-Verify`）の交換は手動（**EC2 を止めた状態で**: Pulumi の `random` を作り直す → `pulumi up` → 次の起動の boot で Caddy が読み直す。動いている間に行うと Caddy が 403 を返し、Windows エージェントは認証の失敗として送信を止める。`AWS_OPERATIONS.md` §9）。
