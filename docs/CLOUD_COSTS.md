# CLOUD_COSTS（T1.6 クラウド費用比較 + T1.8 停止・再開方式の事前調査）

確認日: **2026-10-22**（JST）。調査・試算のみ。課金リソース作成・契約・決済なし。**クラウド選定（T1.7）と運用モード方式の最終確定（T1.8）は本書を確認した後にユーザーが行う**。本書は推奨を示すが決定ではない。

## 0. 前提・方法・信頼度

### 0.1 金額の条件
| 項目 | 内容 |
|---|---|
| 通貨 | USD で単価取得 → **円換算** |
| 為替 | **1 USD = 156 円（仮定）**。参照値: 2026-09-16 実績 156.25 円（poundsterlinglive 等の検索結果。10月の確定値は未取得）。±10 円で総額は約 ±6% 動く |
| 税 | 表の金額は**税抜**。日本の消費税 10% が請求に加算される前提で「税込目安 = ×1.10」。契約形態（請求書払い/カード/Marketplace 等）で変わるため要確認 |
| 月 | 730 時間 / 30 日 |
| リージョン | 東京（GCP asia-northeast1, AWS ap-northeast-1, Azure Japan East） |

### 0.2 データの信頼度ランク
| ランク | 意味 | 該当 |
|---|---|---|
| **A** | 公式の料金表を機械的に取得（確認日の値） | AWS 東京の料金は AWS 公式 Price List API（`pricing.us-east-1.amazonaws.com`）から取得。GCP の Cloud Run / Scheduler / Secret Manager / Artifact Registry は公式料金ページから取得 |
| **B** | 公式情報を基にした推定 | **Cloud SQL 東京**: 公式ページの地域別表は JS 動的でこの環境から取得できず、公式の Iowa（us-central1）単価 × **係数 1.30（推定）**。係数は Bytebase が示す Osaka/Seoul の db-g1-small（$33）÷公式 Iowa（$25.55）≈1.29 に基づく。**東京の実額は GCP 料金計算機で要確認** |
| **C** | 第三者情報・検索スニペット・記憶ベース | Azure 全般（`prices.azure.com` / `azure.microsoft.com` に接続不可）。Azure の数値は US East の第三者値に地域係数 1.15 を仮定。**参考値であり確定情報として扱わない** |

### 0.3 環境制約（正直な記録）
接続不可: `docs.cloud.google.com`、`aws.amazon.com`（料金ページ）、`docs.aws.amazon.com`、`azure.microsoft.com`、`prices.azure.com`、`learn.microsoft.com`、`dev.mysql.com` 等。したがって停止・再起動の公式仕様（§6）は **WebSearch が返した公式ドキュメントの抜粋**に依存し、原文全体は未確認。該当箇所には「要確認」を付けた。

### 0.4 負荷の仮定（試算の入力）
| 項目 | 条件A（通常・2人） | 条件C-100 | 条件C-1000 |
|---|---|---|---|
| Web 実行時間（リクエスト処理中） | 40 h/月（1 vCPU / 1 GiB） | 100 h | 400 h |
| bot | 月 8〜12 日 × 8〜12 時間 → **64 / 100 / 144 h**（代表は 100 h）。1 vCPU / 2 GiB、Job。別に日次の軽量開催確認 Job（0.5 vCPU, 15 分/月相当） | 同左（bot は利用者数に依存しない） | 同左 |
| DB サイズ | 20 GB（バックアップ使用量も 20 GB 相当） | 50 GB | 200 GB |
| DB 規模 | 最小（共有コア/1GB 級） | 1 vCPU / 3.75 GB 級 | 2 vCPU / 7.5 GB 級（HA なし。HA は別行） |
| 送信（エグレス） | 1 GB | 10 GB | 100 GB |
| 監視・ログ | 無料枠内（ログ 1 GB 未満）＋アラート 3 本 | 同左 | 同左 |
※ JV-Link データの規模（combo_odds_snapshots 等）は T1.10 で保持期間を決める。**DB 20 GB は仮置き**で、増えるとストレージ＋バックアップ費が比例する。Windows 取得エージェントはユーザーの PC 上で動かすためクラウド費用ゼロ（電気代除く）。

## 1. 比較した構成

| ID | 構成 | Web | bot / Job | DB | 備考 |
|---|---|---|---|---|---|
| **G1** | GCP 標準 | Cloud Run（min=0）+ 直接 IAP | Cloud Run Jobs + Cloud Scheduler | Cloud SQL for MySQL **Enterprise** 共有コア db-g1-small（1.7GB）、プライベート IP | Registry=Artifact Registry、Secret Manager、Cloud Logging/Monitoring |
| **G1m** | GCP 最小 | 同上 | 同上 | Cloud SQL **db-f1-micro**（0.6GB） | **MySQL 8.4/9.7 で共有コア（特に f1-micro）が選べるか未確認**、SLA 対象外、メモリ逼迫リスク。条件付き |
| **G2** | GCP + 自己管理 MySQL | Cloud Run | Cloud Run Jobs | Compute Engine VM 上の MySQL（コンテナ） | 最安級だがバックアップ/パッチ/障害対応が自前。**費用は未算出（東京 VM 単価が取得できず）**。採用非推奨（§7） |
| **A1** | AWS サーバーレス | **Lambda（コンテナ or zip）+ API Gateway(HTTP) + Cognito** | EventBridge Scheduler → **Fargate RunTask（ARM）** | RDS for MySQL（db.t4g.micro → small → medium） | Spring Boot の Lambda 化は SnapStart 等の追加検証が必要（§3.4） |
| **A2** | AWS コンテナ常駐 | ECS **Fargate 常時 1 タスク + ALB**（OIDC=Cognito） | EventBridge Scheduler → Fargate RunTask | RDS for MySQL | **スケールゼロ不可**（ALB と常時タスクの固定費） |
| **A3** | AWS Aurora Serverless v2 | Lambda 構成（A1 と同じ） | 同上 | **Aurora MySQL Serverless v2（0 ACU 自動停止）** | DB 停止/再開が自動。MySQL 8.0/8.4 互換（9.7 ではない）。§6.3 |
| **Z1** | Azure | Container Apps（consumption, min=0）+ 組込み認証(Entra) | Container Apps Jobs（スケジュール） | Azure Database for MySQL Flexible Server B1ms | ACR Basic が固定費。数値はランク C |
| 除外 | **AWS App Runner** | — | — | — | **2026-04-30 から新規顧客の受付停止（メンテナンスモード）**と AWS ドキュメントにあるため除外 |
| 参考 | 外部 DBaaS（TiDB Cloud Starter 等） | — | — | MySQL 互換・無料枠 5 GiB 行ストレージ/50M RU/月 | 東京リージョン提供の公式確認なし、Flyway/Doma の互換未検証、20GB は無料枠超過、JRA-VAN データを第三者へ置く規約確認が必要 → **今回は評価対象外** |
| 参考 | 単一 VM + Docker Compose | — | — | — | 最安だが IAP・スケールゼロ・個別デプロイ・一括停止の要件を満たしにくい。採用しない |
| 参考 | Azure/AWS/GCP 以外（OCI Always Free 等） | — | — | — | 未調査。要件（IAP 相当の認証、運用性）で優位が不明のため対象外 |

## 2. 単価（出典つき）

### 2.1 GCP（ランクA/B）
| 項目 | 単価 | 出典 |
|---|---|---|
| Cloud Run 東京 = **Tier 1** | 地域別価格階層で asia-northeast1 は Tier 1（=表の標準価格） | https://cloud.google.com/run/pricing |
| Cloud Run サービス（リクエスト課金） | CPU $0.000024/vCPU-s、メモリ $0.0000025/GiB-s、$0.40/100万リクエスト。無料枠: 180,000 vCPU-s、360,000 GiB-s、200万リクエスト/月（課金アカウント単位） | 同上 |
| Cloud Run サービス（インスタンス課金） | CPU $0.000018、メモリ $0.000002（無料枠 240,000 / 450,000） | 同上 |
| Cloud Run Jobs | CPU $0.000018/vCPU-s、メモリ $0.000002/GiB-s（無料枠 240,000 vCPU-s / 450,000 GiB-s）※Jobs 表の抽出が一部のみのためインスタンス課金と同額と仮定（要確認） | 同上 |
| Cloud SQL Enterprise 汎用（Iowa 基準） | vCPU $0.0413/h、メモリ $0.007/GiB-h、HA は2倍。共有コア: db-f1-micro $0.0105/h、db-g1-small $0.035/h（HA は2倍） | https://cloud.google.com/sql/pricing |
| Cloud SQL ストレージ（Iowa 基準） | SSD $0.000232877/GiB-h（≈$0.17/GB月）、バックアップ使用量 $0.000109589/GiB-h（≈$0.08/GB月）、HA ストレージ2倍 | 同上 |
| Cloud SQL 停止中の IPv4 | **アイドルな IPv4 アドレス $0.01/時（≈$7.3/月）** → 公開 IP を付けると停止中も課金。**プライベート IP のみにする** | 同上 |
| Cloud SQL 東京 | Iowa 単価 × **1.30（推定）** → g1-small ≈ $33.2/月、f1-micro ≈ $10.0/月、SSD ≈ $0.221/GB月、バックアップ ≈ $0.104/GB月 | §0.2 B |
| Cloud Scheduler | $0.10/ジョブ/31日、**無料 3 ジョブ/課金アカウント**（一時停止中ジョブも数える） | https://cloud.google.com/scheduler/pricing |
| Secret Manager | アクティブバージョン $0.06/月（≈$0.000082192/h）、無料 6 バージョン、アクセス 1万回無料→$0.03/1万回 | https://cloud.google.com/secret-manager/pricing |
| Artifact Registry | ストレージ $0.10/GB月（$0.000136986/GiB-h）、無料 0.5 GB | https://cloud.google.com/artifact-registry/pricing |
| 無料枠一覧・新規クレジット | **$300 クレジット**（新規顧客。有効期限はトライアル期間内＝90 日と読み取れる記述、要確認）。Always Free: Cloud Run 200万リクエスト、Secret Manager 6 バージョン、Artifact Registry 0.5GB、Scheduler 3 ジョブ、e2-micro 1 台（米国リージョンのみ、東京対象外・要確認） | https://cloud.google.com/free |
| 直接 IAP（Cloud Run） | 設定は公式ドキュメントに記載（`roles/iap.httpsResourceAccessor`）。**追加料金の有無は確認できず（要確認）**。レイテンシ増の注記あり | https://docs.cloud.google.com/run/docs/securing/identity-aware-proxy-cloud-run |
| Cloud Logging/Monitoring | 無料枠内想定（ログ 50GiB/月の記憶あり・**未確認**）。アラートポリシーの課金は未確認 | https://cloud.google.com/stackdriver/pricing |
| エグレス | $0.12/GB と仮定（アジア向けプレミアム、無料枠 1GiB は北米向けのみとの記述あり） | Cloud Run 料金ページ |

### 2.2 AWS（ランクA: 公式 Price List API、東京 ap-northeast-1）
| 項目 | 単価 |
|---|---|
| Fargate（x86） | vCPU $0.05056/h、メモリ $0.00553/GB-h、エフェメラル $0.000133/GB-h |
| Fargate（ARM） | vCPU $0.04045/h、メモリ $0.00442/GB-h |
| ALB | $0.0243/h（≈$17.7/月）+ LCU $0.008/h |
| RDS for MySQL Single-AZ | db.t4g.micro $0.025/h（$18.25/月）、small $0.050/h、medium $0.101/h、db.t3.micro $0.026/h |
| RDS ストレージ gp3 | $0.138/GB月（Multi-AZ は $0.276）。バックアップ超過分 $0.095/GB月（プロビジョニング容量までは無料と AWS 一般仕様、要確認） |
| Aurora MySQL Serverless v2 | $0.15/ACU-h（I/O-Optimized は $0.20）、ストレージ $0.12/GB月（PostgreSQL 表の値、MySQL も同額と推定）、I/O $0.24/100万、バックアップ超過 $0.023/GB月 |
| Lambda | リクエスト $0.20/100万（無料 100万/月）、ARM $0.0000133334/GB-s |
| API Gateway（REST） | $4.25/100万（HTTP API の単価は未抽出。2 人利用では誤差） |
| Cognito | 50,000 MAU まで無料枠（Lite/Essentials の区別は未確認） |
| EventBridge Scheduler | 1,400万呼び出しまで無料 |
| Secrets Manager | $0.40/シークレット月、$0.05/1万 API |
| ECR | $0.10/GB月 |
| CloudWatch | ログ取込 $0.76/GB、アラーム $0.10/本、カスタムメトリクス $0.07/本月 |
| パブリック IPv4 | $0.005/h（使用中・アイドルとも） |
出典: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/{AmazonECS,AmazonRDS,AWSELB,AWSSecretsManager,AmazonECR,AmazonCloudWatch,AWSLambda,AmazonApiGateway,AmazonCognito,AmazonVPC,AWSEvents}/current/ap-northeast-1/index.json

### 2.3 Azure（ランクC・要再確認）
| 項目 | 値 | 根拠 |
|---|---|---|
| Container Apps（consumption） | 無料枠 180,000 vCPU-s / 360,000 GiB-s / 200 万リクエスト（サブスクリプション単位）。参考単価 active $0.000024/vCPU-s、idle $0.000003、メモリ $0.000003/GiB-s、$0.40/100万（East US、第三者の記載。公式ページは価格が表示されず確認不可） | 検索結果（azure.microsoft.com 無料枠の記載 + devzero 第三者） |
| MySQL Flexible Server B1ms | 約 $12/月（East US、第三者）→ 東京は ×1.15 の仮定で $13.8 | Bytebase 等 |
| ストレージ | $0.13/GB月（仮定） | 仮定 |
| ACR Basic | ≈$5/月（$0.167/日の記憶） | 未確認 |
| 新規クレジット | $200/30日（記憶）— 未確認 | — |

### 2.4 為替・税・無料枠・クレジットの扱い
- 「**無料枠適用時**」= 常設の Always Free / 月次無料枠を差し引いた金額（条件が満たされる前提）。「**無料枠を除いた金額**」= 同じ使用量を全額課金した場合。
- **新規契約クレジット**（GCP $300 など）は上記どちらにも含めない。クレジットは期限付き・一時的で、運用費の見積に含めると過小になるため。AWS（新規アカウントの Free Plan/クレジット）と Azure（$200/30 日）の条件は検索結果から**確認できていない**。

## 3. 試算結果

### 3.1 条件A（通常運用: Web 常時閲覧可・bot 開催日のみ）— 月額（税抜）
bot の稼働時間を 64 / **100** / 144 時間に振った幅（代表=100h）。「内訳」は代表ケース。

| 構成 | 無料枠適用 USD | 無料枠適用 円 | 税込目安 円 | 無料枠除外 円 | 主な内訳（USD, 代表ケース） | 信頼度 |
|---|---|---|---|---|---|---|
| **G1 GCP 標準 (g1-small)** | 40.1 / **42.8** / 46.3 | 6,260 / **6,670** / 7,220 | 約 7,300 | 約 8,200 | SQL 計算 33.2、SQL SSD 4.4、SQL バックアップ 2.1、Cloud Run Jobs 2.7、Web 0.0（無料枠内）、その他 0.4 | B（Cloud SQL 東京は推定） |
| **G1m GCP 最小 (f1-micro)** | 16.9 / **19.5** / 23.0 | 2,630 / **3,050** / 3,590 | 約 3,350 | 約 4,560 | SQL 計算 10.0、SSD 4.4、バックアップ 2.1、Jobs 2.7、その他 0.4 | B+条件付き（§1） |
| **A1 AWS Lambda + RDS micro** | 28.1 / **30.0** / 32.4 | 4,380 / **4,680** / 5,060 | 約 5,150 | 約 5,000 | RDS 18.3、gp3 2.8、Fargate bot 5.4、Secrets 1.2、CloudWatch 1.5、Lambda/APIGW 0.6、ECR 0.2 | A（価格）/ Spring on Lambda は要検証 |
| **A2 AWS Fargate + ALB + RDS** | 約 75 / **76.9** / 約 79 | 約 11,700 / **12,000** / 約 12,300 | 約 13,200 | 約 12,200 | Web Fargate 22.5、ALB 17.7、ALB IPv4 7.3、RDS 18.3、gp3 2.8、bot 5.4 ほか | A |
| **A3 AWS Aurora Serverless v2** | 約 22〜30 | 約 3,400〜4,700 | 約 3,800〜5,200 | — | ACU 10〜20、ストレージ 2.4、I/O・バックアップ 1〜3、bot 5.4、他 3 | A（ただし ACU 稼働時間の仮定に依存、粗い） |
| **Z1 Azure** | 31.4 | 4,900 | 約 5,400 | 約 5,740 | Container Apps 9.7、MySQL B1ms 13.8、ストレージ 2.6、ACR 5.0 | **C** |
注: A2 は ALB と常時タスクのため bot 時間以外ほぼ固定。A3 は DB が bot 実行時と Web アクセス時にだけ ACU 課金されるため、ACU 平均（0.5〜1）と稼働時間（約 120〜160h）の幅で粗く示した。

### 3.2 条件B（1か月すべて停止・データ保持）— 月額（税抜）
| 構成 | USD | 円 | 税込目安 | 停止中に残る課金（内訳） | 補足・制約 |
|---|---|---|---|---|---|
| **G1/G1m** | 6.75 | 約 1,050 | 約 1,160 | DB ストレージ 4.4（20GB）+ 残存バックアップ 2.1 + Registry 0.1 + Secret 0.1（+ **公開 IP を付けた場合 +7.3**） | Cloud SQL は停止中も**ストレージと IP は課金**（公式）。停止は `activation policy = NEVER`。自動再起動の記述は確認できず（§6.1） |
| **A1/A2** | 4.4 | 約 690 | 約 760 | RDS gp3 2.8 + Secrets 1.2 + ECR 0.15 +他 | **RDS は停止しても最大 7 日で自動起動**（公式）→ 7 日未満ごとの再停止ループが必須。1か月完全停止＝この仕組み次第。自動起動した時間はインスタンス課金 |
| **A3** | 約 3.5 | 約 550 | 約 600 | Aurora ストレージ + バックアップ（$0.12/GB月） | 接続が無ければ ACU 0 で自動停止。**接続試行で自動再開**するため STOPPED では DB への経路遮断が必須 |
| **Z1** | 7.7 | 約 1,200 | 約 1,320 | MySQL ストレージ 2.6 + **ACR Basic 5.0（停止不可の固定費）** | **30 日連続停止で自動起動**（公式）。Container Apps は 0 スケール |
無料枠除外: G1 約 $7.4（約 1,150 円）。

### 3.3 条件C（利用者 100 / 1,000 人）— 月額（税抜、HA なし）
| 構成 | 100 人 USD | 100 人 円 | 1,000 人 USD | 1,000 人 円 | 主な増加要因 |
|---|---|---|---|---|---|
| **G1 系（Cloud SQL を段階拡張）** | 88.8 | 約 13,860 | 241.5 | 約 37,670 | DB: 1vCPU/3.75GB（$64）→ 2vCPU/7.5GB（$128）、ストレージ・バックアップ、Web 計算（1000人で $33）、エグレス |
| **A1 AWS Lambda + RDS** | 55.5 | 約 8,660 | 141.5 | 約 22,080 | RDS small→medium、Lambda/APIGW/Cognito、エグレス |
| **A2 AWS Fargate + ALB** | 100.3 | 約 15,650 | 168.5 | 約 26,290 | 固定費（ALB・常時タスク）に利用者増の分 |
| **Z1 Azure** | 56.7 | 約 8,850 | 203.3 | 約 31,710 | ランク C（参考） |
- **HA（高可用性）を追加すると** DB 計算・ストレージが約 2 倍（GCP/AWS とも）。初期は不要（要件）。
- **一般公開**する場合は別途: GCP は外部 HTTPS ロードバランサ（固定費約 $18/月 + IAP/Cloud Armor、東京単価は未確認）、利用者認証（Identity Platform 等の MAU 課金は未確認）が必要。AWS は Cognito（50,000 MAU 無料枠）+ API Gateway/ALB。**1,000 人規模でも DB の増強が支配的で、クラウド間の差は小さくなる**。
- Cloud Run の 1,000 人時の Web 計算は「リクエスト処理中 400h」の保守的仮定。実際は同時実行で減る。

### 3.4 補足評価: AWS Lambda / API Gateway / 他のサーバーレス
| 方式 | 費用 | Spring Boot 適合 | 評価 |
|---|---|---|---|
| Lambda + API Gateway(HTTP) + Cognito | 2 人時 ≈ $1 | **コールドスタートが重い**（AWS の記事では Spring 等の Init が最大約 10 秒）。SnapStart で緩和できるが、Spring Boot 4 + Kotlin + Java 25（Lambda の対応ランタイム）と **SnapStart がコンテナイメージで使えるか**は今回確認できず。Web を zip で配布すると web-bot 共通の Docker イメージ契約（web CONTRACTS）と不一致 | 費用は最小だが検証コストが大きい。**Web のみ候補、bot は不可** |
| **bot を Lambda** | — | **実行時間上限 15 分**。bot-run は 8〜12 時間の有限ジョブ | **不可**（Step Functions で分割する再設計が必要になり複雑） |
| bot を Fargate RunTask | 100h で ≈ $5.4 | 問題なし | 良好 |
| App Runner | — | — | **新規受付停止のため除外** |
| ECS Express Mode（App Runner 後継として AWS が推奨） | ALB 共有等、固定費は A2 に近いと推定 | — | 詳細価格未確認 |

## 4. 停止・再開の事前調査（候補ごとの実現可能性と制約）
**重要な発見**: ダッシュボードを「24 時間利用可能」にしたまま DB を停止する構成は、DB 依存のままでは成立しない。NORMAL では DB を常時稼働させる前提で費用を見ている（条件A）。DB を止めて Web だけ見せる案（O-3）は §6.5。

### 4.1 DB 停止中の残存課金・自動再起動・データ保持
| 項目 | GCP Cloud SQL | AWS RDS | AWS Aurora Serverless v2 | Azure MySQL Flexible |
|---|---|---|---|---|
| 停止方法 | `activation policy = NEVER`（stop）。起動は `ALWAYS` | Stop DB instance | 最小 0 ACU の自動一時停止（アイドル 300〜86,400 秒で停止、接続で自動再開） | Stop server |
| 停止中の課金 | **インスタンス課金停止、ストレージ・IP は継続**（公式記述の検索抜粋）。バックアップも保持分は課金。公開 IPv4 はアイドル $0.01/h | **ストレージ（IOPS 含む）、バックアップ、公開 IPv4 は継続**（公式） | 容量課金なし、ストレージ継続（公式+第三者） | **コンピュートは停止、ストレージは継続**（公式） |
| **自動再起動** | 手動停止の場合「再起動するまで停止のまま」（公式記述）。**メンテナンスで起動する旨の記述は確認できず（要確認）**。ストレージ枯渇時は自動停止 | **最大 7 日連続で停止、その後 RDS が自動起動**（公式）。回避は Lambda/EventBridge/Step Functions で再停止 | 該当なし（常時「必要時のみ」）。ただし**接続で再開**、意図しない再開に注意 | **30 日連続停止で自動起動**（公式）。回避は定期的な再停止 |
| 制約 | 読取レプリカ非対応（NEVER 不可） | レプリカあり、停止中の設定変更不可 | 対応エンジンバージョン要確認 | 停止中はバックアップ設定等を変更不可。長期は export 推奨 |
| データ保持 | ストレージ保持 | ストレージ保持 | ストレージ保持 | ストレージ保持 |
| 起動時間 | 数分（目安、未確認） | 数分 | 約 15 秒（第三者。公式の再開時間は未記載） | 数分 |

### 4.2 Web・Job・Scheduler の停止・再開
| 項目 | GCP | AWS | Azure |
|---|---|---|---|
| Web 新規アクセス停止 | (a) Cloud Run `ingress` を internal に変更、(b) IAP 許可リスト（`iap.httpsResourceAccessor`）を空にする（**IAP 直付けでの挙動は未検証・要 PoC**）、(c) サービス削除（不可逆に近く不採用）。Web は 0 スケールなので「停止」＝受付拒否で足りる | API Gateway/Lambda: スロットリング 0 または認可拒否、ALB: リスナールール固定応答 | Container Apps: ingress 無効化 / replicas 0 + 認証で拒否 |
| 実行中 Job の安全な停止 | `gcloud run jobs executions cancel`。アプリ側は SIGTERM を受けチェックポイント保存（bot の「進捗再開」要件）。Job は `max-retries=0` + 冪等実行 | ECS `StopTask`（SIGTERM→SIGKILL 猶予 `stopTimeout` 最大 120 秒） | Job execution の停止 |
| スケジューラ停止/再開 | **`gcloud scheduler jobs pause/resume`**（一時停止中もジョブ課金は継続だが 3 ジョブ無料） | EventBridge Scheduler の `State=DISABLED/ENABLED` | Container Apps Job のスケジュール無効化（更新） |
| 状態管理（desired/actual）の置き場 | **GCS オブジェクト**（バージョニング + `ifGenerationMatch` で排他更新）または Secret Manager。DB 停止中も読める。コスト≈0 | S3 / SSM Parameter Store（標準は無料）/ DynamoDB | Blob / App Configuration |
| GitHub Actions 認証 | OIDC → **Workload Identity Federation**（`google-github-actions/auth` v3.0.0 は Node24） | OIDC → IAM Role（`aws-actions/configure-aws-credentials`） | OIDC フェデレーション |
| 排他制御 | Actions の `concurrency` + GCS `ifGenerationMatch`（二重実行ロック） | 同左（DynamoDB 条件付き書込み） | 同左 |

### 4.3 Terraform が運用モードを変えない方法（共通方針）
1. 状態を「リソース属性」ではなく **Terraform 管理外の desired-state ストア**（GCS オブジェクト等）に置き、Terraform はそのバケットだけを作る（中身を管理しない）。
2. 変更されうる属性は `lifecycle { ignore_changes = [...] }`: Cloud SQL `settings.activation_policy`、Scheduler `paused`、Cloud Run `ingress` / IAP 設定（STOPPED で変えるものに限る）。**Terraform の apply が起動状態を勝手に NORMAL へ戻さない**ことを plan 差分テスト（T5.5）で検証。
3. deploy workflow は `desired=STOPPED` の時 Job/Scheduler を有効化しない（ガード）。deploy は「イメージ digest 更新」のみで DB 起動を行わない。
4. **全て PoC 未実施**（リソース作成禁止のため）。プロバイダの `ignore_changes` の効き方は T5.x で小規模検証する。

### 4.4 start / stop / status の実現性（GitHub Actions `workflow_dispatch`）
- 3 本とも **各 1 回の実行で実現可能**（`gcloud`/`aws`/`az` CLI + OIDC）。`status` は読み取りのみで desired（GCS）と actual（Cloud SQL `state`、Cloud Run ingress/IAP、Scheduler state、実行中 Job 数）を並べて出力する。
- **start 順**: DB 起動（`ALWAYS`、待機）→ 必要ならマイグレーション Job → Web 受付再開 → ヘルスチェック → Scheduler resume → desired=NORMAL。
- **stop 順**: desired=STOPPED を先に書込み（新規実行抑止）→ Scheduler pause → 実行中 Job に停止要求/待機 → Web 受付停止 → DB アクセス遮断確認 → DB 停止 → actual 確認。
- **部分失敗**: 各ステップ冪等（再実行で同じ結果）。desired は最初に確定、actual は毎回計測。`status` が「desired=STOPPED / actual=DB 稼働」のような不一致を表示し、同じ `stop` を再実行すれば収束する。ロック（`concurrency` + GCS 世代条件）で重複実行を防ぐ。失敗時は Job Summary に失敗ステップと復旧コマンドを出力。
- 別途: Windows 取得エージェントは **desired を `GET /internal/ops/mode`（Web 経由）で確認**するが、STOPPED で Web が拒否している場合は取得できない → **STOPPED で拒否応答（503）または到達不能 = 送信しない**と解釈する契約にする（web CONTRACTS に反映が必要）。

## 5. 比較結果

### 5.1 最も月額が安い構成
- 条件A: **G1m（GCP + db-f1-micro）≈ ¥3,050**（ただし MySQL 8.4/9.7 での共有コア可否・東京実額が未確認）。確実に成立する範囲では **A1（AWS Lambda + RDS micro）≈ ¥4,700** と **Z1 Azure ≈ ¥4,900（参考）**、**G1 ≈ ¥6,700**、**A2 ≈ ¥12,000**。
- 条件B（全停止）: **A1/A2 ≈ ¥690 < G1 ≈ ¥1,050 < Z1 ≈ ¥1,200**。ただし AWS は RDS の 7 日自動起動対策が必須。
- 条件C: **A1 が最安**（100人 ≈ ¥8,660、1,000人 ≈ ¥22,080）。ただしこれは Lambda 上で Spring Boot を許容した場合。

### 5.2 管理・運用が容易な構成
**GCP（G1）**。Cloud Run は Docker イメージをそのまま動かせ、スケールゼロ・直接 IAP による許可リスト認証・Jobs・Scheduler・Secret Manager・WIF が同一コンソール/CLI で完結。ALB/VPC/NAT の設計が不要。AWS A1 は Lambda 用の適合作業と Cognito/APIGW の組み合わせ、A2 は ALB/VPC が必要。

### 5.3 停止・再起動要件を満たしやすい構成
- **GCP Cloud SQL**: 手動停止すると**再起動するまで停止**（公式記述）で、自動再起動の記述は確認できない → **最も要件に素直**（メンテナンスの扱いは要確認）。残るのはストレージ＋バックアップ（約 ¥1,050/月）。
- AWS RDS: 7 日自動起動 → 再停止ループが必須（設計・失敗時の費用リスク）。
- Azure: 30 日自動起動。
- Aurora Serverless v2: 停止は自動だが「接続で再開」するため**意図しない再開**の防止（SG/IAM/ネットワーク遮断）が必要。
- ストレージは全クラウドで常に残る（0 円にはできない。完全 0 にするにはエクスポートして削除する運用で、再開時の復元に時間がかかる）。

### 5.4 将来の拡張性
全クラウドとも 1,000 人規模までは DB 増強（垂直拡張）＋ Web スケールアウトで対応可能。差が出るのは一般公開時の認証（GCP: Identity Platform + ロードバランサ、AWS: Cognito + ALB/APIGW、Azure: Entra External ID）と WAF。Cloud Run は 1,000 人でも設定変更中心で拡張でき、**拡張時の作り直しが最小**。AWS A1 は Lambda 制約（コールドスタート/15 分）が将来の足枷になり得る。

### 5.5 総合推奨（※T1.7 で決定。本書は決定ではない）
| 順位 | 構成 | 理由 | 前提・懸念 |
|---|---|---|---|
| **推奨** | **G1 GCP（Cloud Run + Cloud Run Jobs + Cloud SQL Enterprise 共有コア）** | 要件との適合が最も素直（直接 IAP、スケールゼロ、Docker 一貫、Cloud SQL が自動再起動しない）。費用は月 ¥6.7k 前後（東京実額は計算機で確認）と AWS A1 より約 ¥2k 高いが、運用・検証コストが小さい。拡張時の作り直しが最小 | **Cloud SQL 東京実額（推定 ×1.30）**、**共有コアが MySQL 9.7/8.4 で使えるか**、**9.7 でエディション未指定＝Enterprise Plus 既定（高額）→ Enterprise を明示**、直接 IAP の追加料金の有無、停止中は**プライベート IP のみ**（公開 IP は停止中も +$7.3/月） |
| 次点（費用重視） | **G1m**（f1-micro）または **A1（AWS Lambda + RDS micro）** | G1m は DB 計算が約 1/3。A1 は月 ¥4.7k で最安級 | G1m: 共有コア可否・メモリ 0.6GB での安定性・SLA 対象外。A1: Spring Boot on Lambda の検証、RDS 7日自動起動ループ、Web と bot でプラットフォームが分かれる複雑さ |
| 参考 | Z1 Azure | 費用は A1 並みだが数値は低信頼（ランク C）、ACR 固定費、30日自動起動 | 公式料金の再取得が必要 |
| 非推奨 | A2（Fargate + ALB 常時） | 固定費で月 ¥12k。スケールゼロ不可。2 人利用では過剰 | — |
| 非推奨 | G2（自己管理 MySQL VM） | 最安だが運用・バックアップを自前で負う（優先順位の ③より①②を損なう） | — |

**費用差の見方**: G1 と A1 の差は約 ¥2,000/月（年 ¥24,000）。G1m が成立するなら G1 系が最安になる可能性がある。意思決定の鍵は「Cloud SQL 東京の実額と共有コア可否」で、これは**課金なしで GCP 料金計算機とコンソールの作成画面（作成前）で確認可能**。

## 6. 停止・再開方式の候補別メモ（T1.8 の入力）

### 6.1 GCP（Cloud SQL + Cloud Run）
- 実現可能: DB 停止（NEVER）、Scheduler pause、Run Job cancel、Web は ingress/IAP 制御、状態は GCS。
- 制約・要確認: ① 停止中の自動起動（メンテナンス等）② IAP 直付けサービスの ingress 変更/許可リスト空化の挙動 ③ 停止中は課金ゼロにならない（ストレージ＋バックアップ）④ Cloud SQL 起動の所要時間と start workflow の待機上限 ⑤ 公開 IP 禁止。
### 6.2 AWS RDS
- 実現可能: ただし **7 日で自動起動** → EventBridge で 6 日ごとに `StopDBInstance` を再実行（Step Functions）。再開時にはメンテナンス適用待ちの可能性。レプリカ付きは停止不可。
### 6.3 Aurora Serverless v2（0 ACU）
- 停止は自動だが、**STOPPED でも接続試行で再開**する。対策は DB のセキュリティグループを閉じる/IAM 認証を外す/Lambda を止める。対応エンジンバージョン（MySQL）と最小 ACU 0 設定可否は要確認。
### 6.4 Azure
- 30 日自動起動。月 1 回の再停止ジョブ。ACR は停止不可。
### 6.5 「Web は 24h・DB は停止」案（O-3）
DB 依存の画面は DB 稼働が前提。代替は、bot 完了時に集計結果を静的 JSON としてオブジェクトストレージに出力し、DB 停止中は Web がそれを表示する方式。節減額は DB 計算の約 8 割（g1-small で $27/月 ≒ ¥4,200）だが、(a) 画面の再設計、(b) 詳細表示（オッズ履歴等）が使えない、(c) DB 起動までの待ち、(d) 要件「通常運用中は DB 利用可能」と矛盾、のため**採用を推奨しない**。要件を緩める場合の選択肢としてのみ記録。

## 7. 未確認・T1.7 前に必要な確認（優先順）
1. **Cloud SQL 東京の実額**（共有コア / db-custom-1-3840 / SSD / バックアップ）を GCP 料金計算機で取得 → G1/G1m の確定。課金不要。ユーザーの GCP アカウントでの確認が最短。
2. Cloud SQL **MySQL 9.7 / 8.4 の共有コア（f1-micro / g1-small）提供可否**と、9.7 の既定エディションを避ける指定。
3. **直接 IAP（Cloud Run）の追加料金**と、STOPPED 時の ingress / 許可リスト制御の挙動（PoC は実リソースが必要なため承認後）。
4. Cloud SQL **停止中のメンテナンス・自動起動**（公式 FAQ/メンテナンス文書）。
5. AWS 側を有力にする場合: Lambda の Java 25 / SnapStart（コンテナイメージ可否）、Aurora MySQL の 0 ACU 対応バージョン。
6. Azure を検討する場合: Japan East の公式料金（計算機）。
7. 各社の**新規契約クレジット条件**（AWS/Azure）と GCP $300 の有効期限。
8. DB の想定サイズ（保持期間・オッズスナップショットの粒度）— T1.10。
9. 為替・税の請求形態。

## 8. 付録: 内訳の計算式
- GCP Cloud SQL 東京推定: g1-small = 0.035 × 1.30 × 730 = $33.2、f1-micro = 0.0105 × 1.30 × 730 = $9.96、1vCPU/3.75GB = (0.0413 + 3.75×0.007) × 1.30 × 730 = $64.1、2vCPU/7.5GB = $128.2、SSD = 0.000232877 × 730 × 1.30 = $0.221/GB月、バックアップ = $0.104/GB月。
- Cloud Run Jobs(bot 100h, 1vCPU/2GiB): (360,000 − 240,000) × 0.000018 + (720,000 − 450,000) × 0.000002 = $2.70。
- AWS Fargate ARM(bot 100h, 1vCPU/2GB): 100 × (0.04045 + 2 × 0.00442) = $4.93 + IPv4 0.5 = $5.4。
- AWS RDS t4g.micro: 0.025 × 730 = $18.25 + gp3 20GB × 0.138 = $2.76。
- 算出スクリプトは作業用（リポジトリに含めない）。式は上記で再現可能。

## 10. T1.7 再確認（2026-10-22, GCP 採用設計に合わせた更新）
**基準の変更**: 初期構成の見積りは**無料枠・新規クレジットに依存しない「無料枠除外」額を基準**とし、無料枠適用額は参考とする（ユーザー方針）。構成は `ARCHITECTURE.md` §2（dashboard + **ingest 独立サービス** + Jobs + Cloud SQL Enterprise db-g1-small + GCS + Secret Manager + Scheduler 4 本）。

### 10.1 単価の再確認結果
| 項目 | 結果 | 確度 |
|---|---|---|
| **Cloud SQL 東京の正式単価** | **今回も取得できず**。料金ページは地域切替が JS 動的で、静的 HTML は Iowa（us-central1）の値のみ。ヘッドレスブラウザ（Chromium）で地域セレクタの操作を試したが選択が反映されず失敗。→ **引き続き Iowa × 1.30 の推定**（下限として Iowa 単価そのもの = 係数 1.0 も併記） | 推定（B） |
| Cloud SQL（Iowa 公式, 2026-10-22 取得） | db-f1-micro $0.0105/h、db-g1-small $0.035/h（HA は 2 倍）、Enterprise 汎用 vCPU $0.0413/h・メモリ $0.007/GiB-h、Enterprise Plus N2 vCPU $0.0537・メモリ $0.0091、SSD $0.000232877/GiB-h、HDD $0.000123288、バックアップ $0.000109589/GiB-h、**アイドルな IPv4 $0.01/h** | 公式（A） |
| エディション | 共有コアは **Enterprise のみ**。8.4/9.7 の既定は Enterprise Plus → **明示指定が必須** | 公式抜粋 |
| Cloud Run / Jobs | 東京は Tier 1。サービス（リクエスト課金）CPU $0.000024/vCPU-s・メモリ $0.0000025/GiB-s・$0.40/100万リクエスト、Jobs CPU $0.000018・メモリ $0.000002。無料枠はあるが**基準からは除外** | 公式（A） |
| DB 接続のネットワーク | Cloud Run → Cloud SQL は Direct VPC egress（**コネクタ不要＝VM 課金なし**、egress のみ課金）。同一リージョン内の Cloud SQL ⇄ Compute 間は無料と記載。Cloud Run 側の VPC 向け転送は「VM からの転送」扱い（同一ゾーン無料、ゾーン間は少額）→ 月 $0.1 未満の見込み | 公式抜粋 + 推定 |
| VPC 関連の固定費 | コネクタ・Cloud NAT・LB を**使わない**設計のため 0。プライベートサービスアクセス自体の課金は確認できず（G-NET-1） | 推定 |
| IAP | 追加料金の記載を公式で確認できず（第三者は無料と記載）。**0 円と仮定（未確認）** | 未確認 |
| Artifact Registry | $0.10/GB月（0.5 GB 無料）。クリーンアップで約 3 GB → $0.30 | 公式（A） |
| Secret Manager | $0.06/版月（6 版無料）、アクセス 1 万回 $0.03（1 万回無料）。約 8 版 → $0.48 | 公式（A） |
| GCS | Standard（既定表示の us-central1）$0.000027397/GiB-h ≈ $0.02/GB月。東京は未取得（同程度と推定）。合計 1 GB 未満 → $0.03 未満。ビーコンの読取（エージェント）はクラス B 操作で月 1 万回未満 → 誤差 | 公式（A）/推定 |
| Cloud Logging | $0.50/GiB（取込）、**最初の 50 GiB/プロジェクト/月は無料**、保持 30 日込み | 公式（A） |
| Cloud Monitoring | アラートポリシーは**2027-09-01 以降**に指標参照あたり $0.35/月の課金開始予定。アップタイムチェックは 100 万回/プロジェクト無料 | 公式（A） |
| バックアップ | 使用量 × $0.000109589/GiB-h（Iowa）≈ $0.08/GB月（東京推定 $0.104）。7 世代保持（増分）で DB サイズ相当と仮定 | 公式 + 仮定 |
| データ転送 | インターネット向け egress $0.12/GB と仮定（1 GB/月） | 仮定 |
| GitHub Actions | Private リポジトリは無料プランの分数内（CI のビルド量次第で超過の可能性）。**超過時の単価は未確認** | 未確認 |
| 停止中の残存費用 | Cloud SQL ストレージ + バックアップ、Artifact Registry、Secret Manager、GCS、Scheduler（停止中のジョブも課金対象） | 公式 |

### 10.2 月額（税抜。為替 156 円/USD。条件A=bot 64/100/144 時間）
| 構成要素（bot 100h） | 無料枠除外（基準） | 無料枠適用（参考） |
|---|---|---|
| Cloud SQL db-g1-small（東京推定） | $33.22 | $33.22 |
| SSD 20 GB | $4.42 | $4.42 |
| バックアップ 20 GB | $2.08 | $2.08 |
| dashboard（処理 40h） | $3.82 | $0 |
| ingest（ハートビート 60 秒毎 + 開催日の取込） | $1.0 | $1.0 |
| Jobs（bot 100h + calendar-check 1,560 回/月 + 他） | $8.39 | $3.17 |
| Scheduler 4 本 | $0.40 | $0.10 |
| Artifact Registry 約 3 GB | $0.30 | $0.25 |
| Secret Manager 約 8 版 | $0.48 | $0.12 |
| GCS（状態・ビーコン・モデル） | $0.03 | $0.03 |
| Logging（1 GiB 未満） | $0.50 | $0 |
| ネットワーク（egress 等） | $0.17 | $0.17 |
| IAP / VPC 固定費 / Monitoring（2027-08 まで） | $0（未確認） | $0 |
| **合計（東京推定 ×1.30）** | **$54.8 ≈ ¥8,550（税込目安 ¥9,400）** | $44.6 ≈ ¥6,950 |
| 合計（下限 = Iowa 単価） | $45.6 ≈ ¥7,120 | $35.4 ≈ ¥5,520 |
| bot 64h / 144h（東京推定・無料枠除外） | ¥8,100 / ¥9,090 | ¥6,510 / ¥7,490 |
- **2027-09 以降**: Monitoring のアラートポリシーを 5 指標で運用すると +$1.75/月（約 ¥270）。初期は GitHub Actions の定期 status を主にする（OPERATIONS_DESIGN §9）。
- **db-custom-1-3840 へ変更した場合**（共有コア不可時）: +$30.9/月 ≈ **+¥4,820/月**（東京推定）。

### 10.3 条件B（1 か月全停止）
| | 無料枠除外（基準） | 無料枠適用 |
|---|---|---|
| 東京推定（SSD 20GB + バックアップ + AR + Secret + GCS + Scheduler） | **$7.7 ≈ ¥1,200（税込 ¥1,320）** | $7.0 ≈ ¥1,090 |
| 下限（Iowa 単価） | $6.2 ≈ ¥970 | $5.5 ≈ ¥860 |
- 公開 IP を持たないため IPv4 アイドル課金（$7.3/月）は発生しない前提（プライベート IP の扱いは G-OPS-2 で請求レポートにより確認）。
- **停止中に DB が自ら起動した場合**は、その時間だけインスタンス課金（db-g1-small 推定 $0.0455/h ≈ ¥7/h）が発生する。定期 status で検知（最長 24 時間 ≈ ¥170）。

### 10.4 条件C（参考、§3.3 を踏襲）
100 人: DB を db-custom-1-3840 に上げて約 ¥13,900、1,000 人: 約 ¥37,700（HA なし）。一般公開時の LB/Cloud Armor/Identity Platform は別途（規約上 JRADB 前提）。

### 10.5 結論（T1.7）
- GCP 案（Enterprise db-g1-small）の通常運用は **月約 ¥8,500（無料枠に依存しない基準・東京推定）**。AWS A1（¥4,700〜5,000）より約 ¥3,500 高いが、停止要件の素直さ（自動起動なし）・運用の単純さ・直接 IAP によるアクセス制御・拡張時の作り直しの少なさを優先して**採用**（DECISIONS I-011）。費用面の**重大な問題は確認されていない**（予算の上限はユーザー未提示）。
- **確定前の必須確認（課金不要）**: Cloud SQL 東京の正式単価（GCP 料金計算機またはコンソールのインスタンス作成画面の見積り表示）と、MySQL 8.4 Enterprise での db-g1-small の選択可否（G-DB-1, G-COST-1）。差が大きい場合（例: 共有コア不可）は §10.2 の代替額で再評価する。

## 11. 低コスト化の 3 案の再見積り（2026-11-07。比較の正本は web の `docs/HOSTING_OPTIONS.md`。I-040）
**承認・契約ではない**。有料リソースは作っていない。Cloudflare への構成変更は本人の指示で保留（web D-277）。目標は月 1,000 円程度・上限 3,000 円。

- **単価**: 2026-11-07 に cloud.google.com の料金ページから取得（静的な表は Iowa = us-central1。A）。e2-micro $0.008376/h・e2-small $0.016753/h・e2-medium $0.033506/h、pd-standard $0.04/GB 月（30 GB は US の無料枠）・pd-balanced $0.10/GB 月・SSD PD $0.17/GB 月、標準スナップショット $0.05/GB 月、**外部 IPv4（標準 VM で使用中）$0.005/h**・未使用の静的 IP $0.01/h、Cloud SQL db-f1-micro $0.0105/h・db-g1-small $0.035/h（§10 と同じ）・SSD $0.17/GB 月・バックアップ $0.08/GB 月・停止中の公開 IPv4 $0.01/h、Cloud Run Jobs/インスタンス課金 CPU $0.000018/vCPU 秒・メモリ $0.000002/GiB 秒、Scheduler $0.10/ジョブ（3 本無料）、Secret $0.06/版（6 版無料）、Logging $0.50/GiB（50 GiB 無料）。
- **東京は推定**: 地域切替が JS で、この環境のヘッドレスブラウザから操作できなかった（§10.1 と同じ問題。`www.gstatic.com` を許可しても選択が反映されない）。GCE は Iowa × 1.28（第三者値との比。C。ディスク・スナップショットにも同率を仮定）、Cloud SQL は × 1.30。**確定前に料金計算ツールで確認する（G-COST-1）**。
- **結果（税抜。税込は ×1.1・156 円/USD・東京推定・無料枠なし）**: 案 1（Cloud SQL を db-f1-micro・SSD 10 GB・bot-run 0.5 vCPU/1 GiB）常時 ¥3,330／DB を 100 時間だけ起動 ¥1,988（常時無料枠ありで ¥793）。案 2（e2-small + pd-balanced 20 GB + スナップショット + 外部 IP）常時 ¥3,579／100 時間だけ起動 ¥980（Iowa 常時 ¥2,936、1 年確約〔契約〕で東京 ¥2,676）。案 3（Cloudflare 無料 + PC）ドメイン代 約 ¥130〜150 + 電気代。
- **メモリの実測**（web HOSTING_OPTIONS §1）: dashboard・ingest は各 200〜275 MiB、bot は起動〜終了 165〜230 MiB、MySQL 8.4 は絞って 135 MiB（空の DB で実測。260 MiB は見込み）。現行の割当（dashboard/ingest 1 GiB・bot-run 2 GiB）は削減の余地がある（bot-run の周回中は未計測のため、値の変更は計測の後）。

## 12. AWS 構成の見積り（2026-11-13。構成は `AWS_ARCHITECTURE.md`。I-042）
**承認・契約ではない**。有料リソースは作っていない。目標は月 1,000 円程度（3,000 円の予算の通知は上限ではない）。

- **単価の出典**: AWS の公式の価格表（Price List の一括取得 API。`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<サービス>/current/ap-northeast-1/index.json`〔EC2 は `index.csv`〕、Route 53 は global）。**2026-11-13 に取得、価格の有効日 2026-11-01**。東京（ap-northeast-1）・オンデマンド・Linux。
- **前提**: 為替 156 円/USD（§10 と同じ）・**税抜**（税込は ×1.10）・**無料枠を使わない**（Lambda・Scheduler・Cognito の MAU・Budgets の無料分も除外）・新規アカウントの特典・クレジットを除く。
- **単価**: CloudWatch のアラーム $0.10/個月（制御の失敗の検知に 2 個）、EC2 t4g.small $0.0216/h（t3.small $0.0272・t4g.medium $0.0432）、T4g の CPU クレジットの超過 $0.04/vCPU 時、公開 IPv4 $0.005/h（使用中・未使用とも）、EBS gp3 $0.096/GB 月、スナップショット $0.05/GB 月、S3 Standard $0.025/GB 月・PUT 等 $0.0047/千回・GET $0.0037/万回、ECR $0.10/GB 月、Route 53 ゾーン $0.50/月・問合せ $0.40/100 万回、Lambda（arm64）$0.0000133334/GB 秒・$0.20/100 万回、EventBridge Scheduler $1.25/100 万回（1,400 万回まで無料だが除外）、CloudWatch Logs 取込 $0.76/GB・保存 $0.033/GB 月、KMS 要求 $0.03/万回、Cognito Lite $0.0055/MAU、インターネットへの転送 $0.114/GB、AWS Budgets $0.02/日（2 個まで無料。除外した場合）。SSM Parameter Store（標準）・AWS 管理キー・同じリージョンの S3/ECR からの転送は無料。

### 12.1 月額（税抜）
| 項目 | 停止のまま | 100 時間 | 130 時間（開催日 約 9 日 + 閲覧） | 常時起動（730 時間） |
|---|---|---|---|---|
| EC2 t4g.small | $0 | $2.16 | $2.81 | $15.77 |
| 公開 IPv4（動いている間だけ。Elastic IP を作らない） | $0 | $0.50 | $0.65 | $3.65 |
| S3 の PUT（ホストの報告 1 分ごと等。約 72 回/時） | $0 | $0.03 | $0.04 | $0.25 |
| インターネットへの転送（仮定 0〜2 GB） | $0.00 | $0.11 | $0.14 | $0.23 |
| **固定費**（下の内訳） | $5.05 | $5.05 | $5.05 | $5.05 |
| **合計（税抜）** | **$5.06 ≈ ¥789** | **$7.86 ≈ ¥1,226** | **$8.69 ≈ ¥1,356** | **$24.95 ≈ ¥3,891** |
| 税込（×1.10） | ¥868 | ¥1,349 | ¥1,491 | ¥4,281 |

固定費の内訳（停止中もかかる）: EBS gp3 28 GB $2.69（ルート 12 + データ 16）・スナップショット 約 6 GB $0.30（仮定）・S3 保存 約 15.6 GB $0.39（バックアップ 0.5 GB × 約 29 世代 + モデル等 1 GB。仮定）・S3 の GET 約 8 万回 $0.03・ECR 約 2.5 GB $0.25（仮定）・Route 53 $0.50・Lambda $0.05・Scheduler $0.01・Logs $0.01・KMS $0.003・Cognito $0.006・Budgets $0.62（無料の 2 個を使えば $0）・CloudWatch のアラーム 2 個 $0.20（制御の失敗・定期実行の停止。SNS のメールは 1 通 $0.00002 で誤差）。
- **起動 1 時間あたり ≈ ¥4.2**（EC2 + IPv4 + S3 の PUT）。固定費 ≈ ¥789（Budgets の無料分を使えば ≈ ¥692）。
- **CPU クレジット**（unlimited）: 実測の平常時は CPU 1% 未満（基準 20%×2 vCPU を大きく下回る）で、起動時の JVM の負荷は稼働中に貯まるクレジットで賄える見込み → 通常 $0。重い処理（学習で 2 vCPU を 2 時間）でも約 $0.13。**暴走（常に 100%）の最悪**: 100 時間で +$6.4（¥1,000）、常時起動なら +$46.7（¥7,290）。対策: 制御の連続稼働の上限（20 時間）・batch の期限・`cpuCredits=standard` への変更（遅くなるが超過課金なし）。
- **開催日の時間**: 既定の窓は最初の発走の 240 分前〜最後の発走の 150 分後（1 日 約 13 時間）。開催日が月 9 日なら約 115 時間。前後を 150 分・90 分に縮めると約 11 時間/日（月 130 時間 ¥1,356 → 約 108 時間 ¥1,259）。値は `controller.racedayLeadMinutes`・`racedayTailMinutes`（エージェントの準備・払戻の取込に必要な長さは実運用で確認: §12.3）。
- **GCP との比較**（§10・§11 は東京推定）: Cloud SQL の案 1（db-f1-micro を 100 時間）¥1,988、案 2（e2-small を 100 時間）¥980。AWS の 100 時間 ¥1,226 は案 2 に近く、Cloud SQL より安い。AWS の単価は公式の東京の値（推定ではない）。

### 12.2 含めていないもの
ドメインの登録・更新（本人が用意）、GitHub Actions（web は Public で無料、infra は Private で無料の分数の内の見込み。aws-view の待ちは 1 回 最大 約 17 分）、Pulumi の state の S3（数 MB・$0.01 未満）、消費税以外の税、為替の変動、実データの量（DB・バックアップ・モデル）。

### 12.3 未確認（実環境で確かめる）
実データの DB とバックアップの大きさ（S3・スナップショットの額が比例）、ECR の実際の容量、転送量、Budgets の無料の扱い、t4g.small での実際の CPU クレジットの収支（Cost Explorer の `CPUCredits`）、開催日の窓の長さの妥当性。初回の構築の翌月に請求のページで確かめ、ここに追記する。
- **削減の余地**（未実施）: Docker の保存先をデータ用 EBS に移してルートを 8 GB にする（約 −$0.38）、スナップショットを止める（S3 の論理バックアップだけにする。約 −$0.30）、Budgets を無料の 2 個の内にする（−$0.62）。
