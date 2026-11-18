// AWS の資源（東京リージョン）。**適用（pulumi up）は本人の承認後**。費用の内訳は docs/CLOUD_COSTS.md §13、設計は docs/AWS_ARCHITECTURE.md。
// 公開 URL は CloudFront の標準のドメイン（https://d*.cloudfront.net。独自ドメイン・Route 53・ACM・Let's Encrypt は使わない: I-050）。
// CloudFront → EC2 は VPC origin（AWS の網の中。EC2 の受信は CloudFront の VPC origin の管理 SG からだけ）。
// 固定費の大きいもの（RDS・NAT Gateway・ALB・Elastic IP・KMS の顧客管理の鍵・Secrets Manager・VPC エンドポイント・WAF）は使わない。
// Lambda は VPC に接続しない（NAT が要らない）。データの EBS は Pulumi の protect と retainOnDelete で誤って消さない。
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { type AwsInfraConfig, arch, renderAppEnv } from "./config.js";
import { renderUserData } from "./userdata.js";

export const IMAGES = ["dashboard", "ingest", "bot", "db-migration", "ml-train"] as const;
export const SSM_PREFIX = "/jra-bot";
/** GitHub Actions の信頼の条件（リポジトリ・環境まで固定。ブランチだけの条件にしない）。 */
export const OPS_SUBJECT = (owner: string): string => `repo:${owner}/jra-bot-infra:environment:ops`;
export const WEB_PUSH_SUBJECT = (owner: string): string => `repo:${owner}/jra-bot-web:environment:release`;

/** ops のロール（GitHub Actions の本人の操作）に許すこと。EC2 を直接起動・停止する権限は持たせない（必ず制御の Lambda を通す）。 */
export const OPS_ACTIONS = [
  "lambda:InvokeFunction",
  "ssm:SendCommand",
  "ssm:GetCommandInvocation",
  "s3:PutObject",
  "ssm:GetParameter",
  "ssm:PutParameter",
] as const;

/** CloudFront の管理ポリシー（docs.aws.amazon.com の『Use managed cache policies』『Use managed origin request policies』。2026-11-17 に確認）。 */
export const CACHE_POLICY_CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
export const ORIGIN_REQUEST_POLICY_ALL_VIEWER = "216adef6-5c7f-47e4-b989-5492eafa07d3";
/** CloudFront の VPC origin の管理 SG の名前（AWS が作る。名前は CloudFront-VPCOrigins-Service-SG で始まる）。 */
export const VPC_ORIGIN_SERVICE_SG = "CloudFront-VPCOrigins-Service-SG*";
/** CloudFront → オリジンの合言葉のヘッダ（Caddy が検査して取り除く。VPC origin の SG に加えた多層の防御）。 */
export const ORIGIN_VERIFY_HEADER = "X-Origin-Verify";
/** 停止中に見せるページ（S3。CloudFront が 502・504 の代わりに返す。エージェントには 503 = 待機: web Responses.cs）。 */
export const OFFLINE_PAGE_PATH = "/_offline/index.html";

function policyDoc(statements: unknown[]): string {
  return JSON.stringify({ Version: "2012-10-17", Statement: statements });
}

export interface AwsOutputs {
  readonly instanceId: pulumi.Output<string>;
  readonly dataVolumeId: pulumi.Output<string>;
  readonly controllerFunction: pulumi.Output<string>;
  readonly stateBucket: pulumi.Output<string>;
  readonly beaconUrl: pulumi.Output<string>;
  readonly opsRoleArn: pulumi.Output<string>;
  readonly hostCommandDocument: pulumi.Output<string>;
  readonly webPushRoleArn: pulumi.Output<string> | undefined;
  readonly ecrRegistry: string;
  readonly cognitoIssuer: pulumi.Output<string>;
  readonly cognitoClientId: pulumi.Output<string>;
  readonly siteUrl: pulumi.Output<string>;
  readonly distributionId: pulumi.Output<string>;
  readonly vpcOriginId: pulumi.Output<string>;
}

export function defineAwsInfra(c: AwsInfraConfig, provider: aws.Provider, root = "."): AwsOutputs {
  const o = { provider };
  const p = c.prefix;
  const tags = { project: "jra-bot", managedBy: "pulumi" };
  const region = "ap-northeast-1";
  const ecrRegistry = `${c.accountId}.dkr.ecr.${region}.amazonaws.com`;

  // ---------------------------------------------------------------- ネットワーク（1 サブネット。NAT なし）
  // 外向き（ECR・S3・SSM・Cognito・Discord・OS の更新）はインターネットゲートウェイと公開 IPv4（動いている間だけ課金）で出る。
  // 受信は SG で CloudFront の VPC origin の管理 SG からの 80 番だけ（公開 IP があっても、インターネットから直接は届かない）。
  // AWS の文書は VPC origin を private サブネットで説明している。公開の経路があるサブネットでの動作は初回の構築で確かめる（docs/AWS_OPERATIONS.md の V-1）。
  const vpc = new aws.ec2.Vpc(`${p}-vpc`, { cidrBlock: "10.80.0.0/16", enableDnsHostnames: true, enableDnsSupport: true, tags }, o);
  const igw = new aws.ec2.InternetGateway(`${p}-igw`, { vpcId: vpc.id, tags }, o);
  const subnet = new aws.ec2.Subnet(
    `${p}-public`,
    { vpcId: vpc.id, cidrBlock: "10.80.1.0/24", availabilityZoneId: c.availabilityZoneId, mapPublicIpOnLaunch: false, tags },
    o,
  );
  const rt = new aws.ec2.RouteTable(`${p}-rt`, { vpcId: vpc.id, routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: igw.id }], tags }, o);
  const rta = new aws.ec2.RouteTableAssociation(`${p}-rta`, { subnetId: subnet.id, routeTableId: rt.id }, o);
  // 受信の規則はここに書かない（CloudFront の VPC origin の管理 SG からの 80 番だけを、VPC origin を作った後に別の規則で足す）。
  // SSH・DB・Docker の管理ポートは開けない（管理は SSM）。インターネットからの受信は無い
  const sg = new aws.ec2.SecurityGroup(
    `${p}-web`,
    {
      vpcId: vpc.id,
      description: "jra-bot: HTTP from the CloudFront VPC origin only (no SSH, no DB, no internet ingress)",
      egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
      tags,
    },
    o,
  );

  // ---------------------------------------------------------------- S3（状態・ビーコン・成果物・バックアップ）。既定の暗号化（SSE-S3）・TLS 必須
  const bucket = (name: string, versioning: boolean): aws.s3.BucketV2 => {
    const b = new aws.s3.BucketV2(
      `${p}-${name}`,
      { bucket: `${p}-${name}-${c.accountId}`, forceDestroy: false, tags },
      { ...o, protect: name !== "beacon" && name !== "site" },
    );
    new aws.s3.BucketServerSideEncryptionConfigurationV2(
      `${p}-${name}-sse`,
      { bucket: b.id, rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" } }] },
      o,
    );
    new aws.s3.BucketOwnershipControls(`${p}-${name}-own`, { bucket: b.id, rule: { objectOwnership: "BucketOwnerEnforced" } }, o);
    if (versioning) new aws.s3.BucketVersioningV2(`${p}-${name}-ver`, { bucket: b.id, versioningConfiguration: { status: "Enabled" } }, o);
    return b;
  };
  const state = bucket("ops-state", true);
  const beacon = bucket("beacon", false);
  const models = bucket("models", true);
  // バックアップもバージョニング（ホストは PutObject だけ。乗っ取られて上書きされても旧版が 7 日残る。DeleteObjectVersion は誰にも渡さない）
  const backups = bucket("backups", true);
  // 停止中のページ（公開しない。CloudFront の OAC だけが読む）
  const site = bucket("site", false);
  for (const [n, b] of [
    ["ops-state", state],
    ["models", models],
    ["backups", backups],
    ["site", site],
  ] as const) {
    new aws.s3.BucketPublicAccessBlock(
      `${n}-pab`,
      { bucket: b.id, blockPublicAcls: true, blockPublicPolicy: true, ignorePublicAcls: true, restrictPublicBuckets: true },
      o,
    );
  }
  // ビーコンだけは公開（署名付き。エージェントが停止中も読める: web CONTRACTS §7.2）。公開するのは beacon/mode.json の読取りだけ
  new aws.s3.BucketPublicAccessBlock(
    `beacon-pab`,
    { bucket: beacon.id, blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: false, restrictPublicBuckets: false },
    o,
  );
  const tlsOnly = (b: aws.s3.BucketV2): pulumi.Output<unknown> =>
    pulumi.interpolate`${b.arn}`.apply((arn) => ({
      Sid: "TlsOnly",
      Effect: "Deny",
      Principal: "*",
      Action: "s3:*",
      Resource: [arn, `${arn}/*`],
      Condition: { Bool: { "aws:SecureTransport": "false" } },
    }));
  for (const [n, b] of [
    ["ops-state", state],
    ["models", models],
    ["backups", backups],
  ] as const) {
    new aws.s3.BucketPolicy(`${n}-policy`, { bucket: b.id, policy: tlsOnly(b).apply((s) => policyDoc([s])) }, o);
  }
  new aws.s3.BucketPolicy(
    "beacon-policy",
    {
      bucket: beacon.id,
      policy: pulumi
        .all([beacon.arn, tlsOnly(beacon)])
        .apply(([arn, tls]) =>
          policyDoc([
            tls,
            { Sid: "PublicBeacon", Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: `${arn}/beacon/mode.json` },
          ]),
        ),
    },
    o,
  );
  // 費用が増え続けないようにライフサイクルで消す（バックアップ: 保持日数、履歴: 90 日、旧版: 30 日、データセット: 90 日）
  new aws.s3.BucketLifecycleConfigurationV2(
    "backups-lifecycle",
    {
      bucket: backups.id,
      rules: [
        { id: "expire-mysql", status: "Enabled", filter: { prefix: "mysql/" }, expiration: { days: c.backupRetentionDays } },
        { id: "noncurrent", status: "Enabled", filter: { prefix: "" }, noncurrentVersionExpiration: { noncurrentDays: 7 } },
        { id: "delete-markers", status: "Enabled", filter: { prefix: "" }, expiration: { expiredObjectDeleteMarker: true } },
        { id: "abort-mpu", status: "Enabled", filter: { prefix: "" }, abortIncompleteMultipartUpload: { daysAfterInitiation: 1 } },
      ],
    },
    o,
  );
  new aws.s3.BucketLifecycleConfigurationV2(
    "ops-state-lifecycle",
    {
      bucket: state.id,
      rules: [
        { id: "history", status: "Enabled", filter: { prefix: "history/" }, expiration: { days: 90 } },
        {
          id: "noncurrent",
          status: "Enabled",
          filter: { prefix: "" },
          noncurrentVersionExpiration: { noncurrentDays: 30 },
          abortIncompleteMultipartUpload: { daysAfterInitiation: 1 },
        },
      ],
    },
    o,
  );
  new aws.s3.BucketLifecycleConfigurationV2(
    "models-lifecycle",
    {
      bucket: models.id,
      rules: [
        { id: "datasets", status: "Enabled", filter: { prefix: "1/datasets/" }, expiration: { days: 90 } },
        { id: "noncurrent", status: "Enabled", filter: { prefix: "" }, noncurrentVersionExpiration: { noncurrentDays: 30 } },
      ],
    },
    o,
  );
  // ホストの運用エージェント・設定（起動のたびに取り直す。SHA-256 で検証）とアプリの運用値
  const hostFile = (key: string, file: string): void => {
    const body = fs.readFileSync(file);
    const sha = createHashHex(body);
    new aws.s3.BucketObjectv2(
      `host-${key}`,
      { bucket: state.id, key: `host/${key}`, source: new pulumi.asset.FileAsset(file), contentType: "application/octet-stream" },
      o,
    );
    new aws.s3.BucketObjectv2(
      `host-${key}-sha256`,
      { bucket: state.id, key: `host/${key}.sha256`, content: `${sha}  ${key}\n`, contentType: "text/plain" },
      o,
    );
  };
  hostFile("jrabot-host.mjs", path.join(root, "build/aws/host/jrabot-host.mjs"));
  hostFile("Caddyfile", path.join(root, "pulumi-aws/host/Caddyfile"));
  hostFile("mysql.cnf", path.join(root, "pulumi-aws/host/mysql.cnf"));
  new aws.s3.BucketObjectv2(
    "app-env",
    { bucket: state.id, key: "control/app.env", content: renderAppEnv(c), contentType: "text/plain" },
    o,
  );

  // ---------------------------------------------------------------- ECR（5 つのイメージ。タグは不変・直近だけ残す）
  const repos = IMAGES.map(
    (n) =>
      new aws.ecr.Repository(
        `ecr-${n}`,
        {
          name: `jra-bot/${n}`,
          imageTagMutability: "IMMUTABLE",
          imageScanningConfiguration: { scanOnPush: true },
          forceDelete: false,
          tags,
        },
        o,
      ),
  );
  for (const [i, r] of repos.entries()) {
    new aws.ecr.LifecyclePolicy(
      `ecr-${IMAGES[i]}-lifecycle`,
      {
        repository: r.name,
        policy: JSON.stringify({
          rules: [
            {
              rulePriority: 1,
              description: "untagged 1 day",
              selection: { tagStatus: "untagged", countType: "sinceImagePushed", countUnit: "days", countNumber: 1 },
              action: { type: "expire" },
            },
            {
              rulePriority: 2,
              description: "keep last 6",
              selection: { tagStatus: "any", countType: "imageCountMoreThan", countNumber: 6 },
              action: { type: "expire" },
            },
          ],
        }),
      },
      o,
    );
  }

  // ---------------------------------------------------------------- Cognito（本人 1 名。自己登録なし・MFA・Lite の料金区分）
  const pool = new aws.cognito.UserPool(
    `${p}-users`,
    {
      name: `${p}-users`,
      userPoolTier: "LITE",
      deletionProtection: "ACTIVE",
      adminCreateUserConfig: { allowAdminCreateUserOnly: true },
      autoVerifiedAttributes: ["email"],
      usernameAttributes: ["email"],
      mfaConfiguration: "ON",
      softwareTokenMfaConfiguration: { enabled: true },
      passwordPolicy: {
        minimumLength: 14,
        requireLowercase: true,
        requireUppercase: true,
        requireNumbers: true,
        requireSymbols: false,
        temporaryPasswordValidityDays: 3,
      },
      accountRecoverySetting: { recoveryMechanisms: [{ name: "verified_email", priority: 1 }] },
      tags,
    },
    { ...o, protect: true },
  );
  new aws.cognito.UserPoolDomain(`${p}-auth-domain`, { domain: c.cognitoDomainPrefix, userPoolId: pool.id }, o);
  new aws.cognito.User(
    "owner",
    {
      userPoolId: pool.id,
      username: c.ownerEmail,
      attributes: { email: c.ownerEmail, email_verified: "true" },
      desiredDeliveryMediums: ["EMAIL"],
    },
    o,
  );
  const issuer = pulumi.interpolate`https://cognito-idp.${region}.amazonaws.com/${pool.id}`;

  // ---------------------------------------------------------------- EC2 とデータの EBS
  const data = new aws.ebs.Volume(
    `${p}-data`,
    {
      availabilityZone: subnet.availabilityZone,
      size: c.dataVolumeGb,
      type: "gp3",
      encrypted: true,
      tags: { ...tags, Name: `${p}-data`, Snapshot: `${p}-data` },
    },
    { ...o, protect: true, retainOnDelete: true },
  );
  const role = new aws.iam.Role(
    `${p}-host`,
    { assumeRolePolicy: policyDoc([{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }]), tags },
    o,
  );
  new aws.iam.RolePolicyAttachment(
    `${p}-host-ssm`,
    { role: role.name, policyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore" },
    o,
  );
  new aws.iam.RolePolicy(
    `${p}-host-inline`,
    {
      role: role.id,
      policy: pulumi.all([state.arn, models.arn, backups.arn, ...repos.map((r) => r.arn)]).apply(([s, m, b, ...rs]) =>
        policyDoc([
          {
            Sid: "ReadState",
            Effect: "Allow",
            Action: ["s3:GetObject"],
            Resource: [`${s}/state/*`, `${s}/control/*`, `${s}/host/*`, `${s}/agent/*`],
          },
          {
            Sid: "WriteReports",
            Effect: "Allow",
            Action: ["s3:PutObject"],
            Resource: [
              `${s}/status/*`,
              `${s}/control/calendar-plan.json`,
              `${s}/control/release.json`,
              `${s}/control/release-previous.json`,
              `${s}/agent/*`,
            ],
          },
          { Sid: "Models", Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource: [`${m}/*`] },
          // バックアップは書くだけ（消すのはライフサイクル。ホストが乗っ取られてもバックアップを消せない）と、戻すときの読取り
          { Sid: "Backups", Effect: "Allow", Action: ["s3:PutObject", "s3:GetObject"], Resource: [`${b}/mysql/*`] },
          { Sid: "EcrAuth", Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: "*" },
          {
            Sid: "EcrPull",
            Effect: "Allow",
            Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"],
            Resource: rs,
          },
          // 秘密はアプリ用だけ（ビーコンの署名鍵は読めない: 制御の Lambda だけ）
          {
            Sid: "Secrets",
            Effect: "Allow",
            Action: ["ssm:GetParameter"],
            Resource: `arn:aws:ssm:${region}:${c.accountId}:parameter${SSM_PREFIX}/*`,
          },
          {
            Sid: "NoBeaconKey",
            Effect: "Deny",
            Action: ["ssm:GetParameter", "ssm:GetParameters"],
            Resource: `arn:aws:ssm:${region}:${c.accountId}:parameter${SSM_PREFIX}/beacon/*`,
          },
        ]),
      ),
    },
    o,
  );
  const profile = new aws.iam.InstanceProfile(`${p}-host`, { role: role.name }, o);
  // 公開 URL・Cognito の client はここに入れない（CloudFront → VPC origin → このインスタンスの順に作るので、循環する）。
  // それらは CloudFront を作った後に S3 の control/site.json に置き、ホストが起動のたびに読む
  const hostJson = pulumi.all([state.bucket, backups.bucket, models.bucket]).apply(([sb, bb, mb]) =>
    JSON.stringify({
      state_bucket: sb,
      backup_bucket: bb,
      models_bucket: mb,
      ssm_prefix: SSM_PREFIX,
      ecr_registry: ecrRegistry,
      allowed_emails: [c.ownerEmail],
    }),
  );
  const userData = pulumi
    .all([state.bucket, data.id, hostJson])
    .apply(([sb, vid, hj]) => renderUserData({ arch: arch(c), stateBucket: sb, dataVolumeId: vid, ecrRegistry, hostJson: hj }));
  const instance = new aws.ec2.Instance(
    `${p}-host`,
    {
      ami: c.amiId,
      instanceType: c.instanceType,
      subnetId: subnet.id,
      vpcSecurityGroupIds: [sg.id],
      iamInstanceProfile: profile.name,
      // 公開 IPv4 は外向きの通信だけに使う（受信は SG で塞ぐ）。Elastic IP は持たない（停止中に課金されないように）。公開 URL は CloudFront なので IP が変わっても同じ
      associatePublicIpAddress: true,
      creditSpecification: { cpuCredits: c.cpuCredits },
      disableApiTermination: true,
      instanceInitiatedShutdownBehavior: "stop",
      // IMDSv2 必須。ホップ 2 はコンテナ（S3 の正本の読取り）がインスタンスの資格情報を使うため
      metadataOptions: { httpTokens: "required", httpPutResponseHopLimit: 2, httpEndpoint: "enabled" },
      rootBlockDevice: { volumeType: "gp3", volumeSize: c.rootVolumeGb, encrypted: true, deleteOnTermination: true },
      userData,
      userDataReplaceOnChange: false,
      tags: { ...tags, Name: `${p}-host` },
    },
    // AMI・user data の変更でインスタンスを作り直さない（データは別の EBS。作り直しは本人の判断で。手順は docs/AWS_OPERATIONS.md §9）。
    // 外への経路（IGW・経路表の関連付け）が出来てから作る: user data の取得は一度だけで、失敗すると戻らない（レビュー B2）
    { ...o, ignoreChanges: ["ami", "userData"], dependsOn: [igw, rt, rta] },
  );
  new aws.ec2.VolumeAttachment(
    `${p}-data-attach`,
    { deviceName: "/dev/sdf", volumeId: data.id, instanceId: instance.id, stopInstanceBeforeDetaching: true },
    o,
  );

  // ---------------------------------------------------------------- CloudFront（標準の URL・標準の証明書）と VPC origin
  // 作る順: EC2（作成時は動いている。VPC origin は対象が Active でないと作れない）→ VPC origin（Deployed まで最大 15 分）→ 管理 SG からの受信 →
  // distribution → Cognito の戻り先（distribution のドメインが決まってから）→ control/site.json → 制御の定期実行（最後: 初回の構築の途中で止めない）
  const vpcOrigin = new aws.cloudfront.VpcOrigin(
    `${p}-origin`,
    {
      vpcOriginEndpointConfig: {
        name: `${p}-host`,
        arn: instance.arn,
        httpPort: 80,
        httpsPort: 443,
        // CloudFront → VPC origin は AWS の網の中（公開のインターネットを通らない）。EC2 に公開の証明書は置けないので HTTP（docs/AWS_ARCHITECTURE.md §6）
        originProtocolPolicy: "http-only",
        originSslProtocols: { items: ["TLSv1.2"], quantity: 1 },
      },
      tags,
    },
    // Deployed まで最大 15 分（AWS の文書）。provider の既定の待ち（15 分）では足りないことがある（レビュー B3）。
    // インスタンスの置換えは VPC origin のその場の更新になり、使用中は失敗し得るので未対応（手作業: docs/AWS_OPERATIONS.md §9。レビュー B1）
    { ...o, customTimeouts: { create: "30m", update: "30m", delete: "30m" } },
  );
  // CloudFront が作る管理 SG（このアカウントの distribution の VPC origin からだけ）を受信元にする。管理プレフィックスリストは使わない
  // （公開 IP があるので、他人の distribution からも届いてしまう）
  const serviceSg = aws.ec2.getSecurityGroupOutput(
    {
      filters: [
        { name: "vpc-id", values: [vpc.id] },
        { name: "group-name", values: [VPC_ORIGIN_SERVICE_SG] },
      ],
    },
    { ...o, dependsOn: [vpcOrigin] },
  );
  const ingressFromCloudFront = new aws.vpc.SecurityGroupIngressRule(
    `${p}-from-cloudfront`,
    {
      securityGroupId: sg.id,
      referencedSecurityGroupId: serviceSg.id,
      ipProtocol: "tcp",
      fromPort: 80,
      toPort: 80,
      description: "HTTP from the CloudFront VPC origin (service-managed SG) only",
      tags,
    },
    o,
  );
  // CloudFront → オリジンの合言葉（Caddy が検査する。値は Pulumi の state で暗号化・SSM の SecureString でホストへ）
  const originVerify = new random.RandomPassword(`${p}-origin-verify`, { length: 48, special: false }, o);
  new aws.ssm.Parameter(
    "origin-verify",
    { name: `${SSM_PREFIX}/origin-verify`, type: "SecureString", value: originVerify.result, tags },
    o,
  );
  const oac = new aws.cloudfront.OriginAccessControl(
    `${p}-site-oac`,
    { name: `${p}-site`, originAccessControlOriginType: "s3", signingBehavior: "always", signingProtocol: "sigv4" },
    o,
  );
  const distribution = new aws.cloudfront.Distribution(
    `${p}-cdn`,
    {
      enabled: true,
      comment: "jra-bot (owner only)",
      httpVersion: "http2and3",
      isIpv6Enabled: true,
      priceClass: "PriceClass_200",
      origins: [
        {
          originId: "host",
          domainName: instance.privateDns,
          vpcOriginConfig: { vpcOriginId: vpcOrigin.id, originReadTimeout: 60, originKeepaliveTimeout: 5 },
          // 停止中は早く停止中のページを返す（既定の 3 回 × 10 秒を待たない）
          // 起動直後・CPU クレジットの不足で 3 秒・1 回では「停止中」の案内が出ることがある（レビュー B8）。停止中の案内までは最大 約 10 秒
          connectionAttempts: 2,
          connectionTimeout: 5,
          customHeaders: [{ name: ORIGIN_VERIFY_HEADER, value: originVerify.result }],
        },
        { originId: "offline", domainName: site.bucketRegionalDomainName, originAccessControlId: oac.id },
      ],
      // 画面・API・認証・エージェントは**キャッシュしない**（CachingDisabled）。Cookie・Authorization・クエリ・全メソッドをそのまま渡す（AllViewer）
      defaultCacheBehavior: {
        targetOriginId: "host",
        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
        cachedMethods: ["GET", "HEAD"],
        cachePolicyId: CACHE_POLICY_CACHING_DISABLED,
        originRequestPolicyId: ORIGIN_REQUEST_POLICY_ALL_VIEWER,
        compress: false,
      },
      orderedCacheBehaviors: [
        {
          pathPattern: "/_offline/*",
          targetOriginId: "offline",
          viewerProtocolPolicy: "https-only",
          allowedMethods: ["GET", "HEAD"],
          cachedMethods: ["GET", "HEAD"],
          cachePolicyId: CACHE_POLICY_CACHING_DISABLED,
          compress: false,
        },
      ],
      // エラーはキャッシュしない（停止中の 502・504 が再起動の後も残らない。認証の失敗・アプリの 4xx/5xx も他の要求に返さない）。
      // 502・504（EC2 に届かない = 停止中）だけ停止中のページに置き換える。503 はアプリ・ingest の応答（X-Ops-Mode 付き）なので置き換えない
      customErrorResponses: [
        ...[400, 403, 404, 405, 414, 416, 500, 501, 503].map((code) => ({ errorCode: code, errorCachingMinTtl: 0 })),
        ...[502, 504].map((code) => ({ errorCode: code, errorCachingMinTtl: 0, responseCode: 503, responsePagePath: OFFLINE_PAGE_PATH })),
      ],
      restrictions: { geoRestriction: { restrictionType: "none" } },
      viewerCertificate: { cloudfrontDefaultCertificate: true },
      waitForDeployment: true,
      tags,
    },
    { ...o, dependsOn: [ingressFromCloudFront] },
  );
  new aws.s3.BucketPolicy(
    "site-policy",
    {
      bucket: site.id,
      policy: pulumi.all([site.arn, tlsOnly(site), distribution.arn]).apply(([arn, tls, dist]) =>
        policyDoc([
          tls,
          {
            Sid: "CloudFrontOnly",
            Effect: "Allow",
            Principal: { Service: "cloudfront.amazonaws.com" },
            Action: "s3:GetObject",
            Resource: `${arn}/_offline/*`,
            Condition: { StringEquals: { "AWS:SourceArn": dist } },
          },
        ]),
      ),
    },
    o,
  );
  new aws.s3.BucketObjectv2(
    "offline-page",
    {
      bucket: site.id,
      key: OFFLINE_PAGE_PATH.slice(1),
      source: new pulumi.asset.FileAsset(path.join(root, "pulumi-aws/host/offline.html")),
      contentType: "text/html; charset=utf-8",
      cacheControl: "no-store",
    },
    o,
  );
  const siteHost = distribution.domainName;
  const siteUrl = pulumi.interpolate`https://${siteHost}`;
  const cognitoDomain = `${c.cognitoDomainPrefix}.auth.${region}.amazoncognito.com`;

  // Cognito の client（戻り先・ログアウトの先は CloudFront の URL。distribution の後に作る）
  const client = new aws.cognito.UserPoolClient(
    `${p}-web`,
    {
      userPoolId: pool.id,
      generateSecret: true,
      allowedOauthFlowsUserPoolClient: true,
      allowedOauthFlows: ["code"],
      allowedOauthScopes: ["openid", "email"],
      supportedIdentityProviders: ["COGNITO"],
      callbackUrls: [pulumi.interpolate`https://${siteHost}/oauth2/callback`],
      logoutUrls: [pulumi.interpolate`https://${siteHost}/`],
      preventUserExistenceErrors: "ENABLED",
      idTokenValidity: 60,
      accessTokenValidity: 60,
      refreshTokenValidity: 1,
      tokenValidityUnits: { idToken: "minutes", accessToken: "minutes", refreshToken: "days" },
      explicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH"],
    },
    o,
  );
  // client secret は Pulumi の secret 出力（state では暗号化）→ SSM の SecureString（ホストが起動時に読む）
  new aws.ssm.Parameter(
    "cognito-client-secret",
    { name: `${SSM_PREFIX}/cognito-client-secret`, type: "SecureString", value: client.clientSecret, tags },
    o,
  );
  // ホストが起動のたびに読む公開 URL と Cognito の設定（秘密ではない）
  const siteJson = new aws.s3.BucketObjectv2(
    "site-json",
    {
      bucket: state.id,
      key: "control/site.json",
      content: pulumi
        .all([siteHost, issuer, client.id])
        .apply(([h, iss, cid]) =>
          JSON.stringify({ schema_version: 1, site_host: h, cognito_issuer: iss, cognito_client_id: cid, cognito_domain: cognitoDomain }),
        ),
      contentType: "application/json",
    },
    o,
  );

  // データの EBS の週 1 回のスナップショット（停止中でも作れる。世代数で上限）
  if (c.snapshotRetain > 0) {
    const dlmRole = new aws.iam.Role(
      `${p}-dlm`,
      { assumeRolePolicy: policyDoc([{ Effect: "Allow", Principal: { Service: "dlm.amazonaws.com" }, Action: "sts:AssumeRole" }]), tags },
      o,
    );
    new aws.iam.RolePolicyAttachment(
      `${p}-dlm-attach`,
      { role: dlmRole.name, policyArn: "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole" },
      o,
    );
    new aws.dlm.LifecyclePolicy(
      `${p}-data-snapshots`,
      {
        description: "jra-bot data volume weekly",
        executionRoleArn: dlmRole.arn,
        state: "ENABLED",
        policyDetails: {
          resourceTypes: ["VOLUME"],
          targetTags: { Snapshot: `${p}-data` },
          schedules: [
            {
              name: "weekly",
              createRule: { cronExpression: "cron(0 18 ? * TUE *)" },
              retainRule: { count: c.snapshotRetain },
              copyTags: true,
            },
          ],
        },
        tags,
      },
      o,
    );
  }

  // ---------------------------------------------------------------- 制御の Lambda（VPC に接続しない）と 5 分ごとの起動
  const logGroup = new aws.cloudwatch.LogGroup(
    `${p}-controller-logs`,
    { name: `/aws/lambda/${p}-controller`, retentionInDays: 14, tags },
    o,
  );
  const lambdaRole = new aws.iam.Role(
    `${p}-controller`,
    { assumeRolePolicy: policyDoc([{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }]), tags },
    o,
  );
  new aws.iam.RolePolicy(
    `${p}-controller-inline`,
    {
      role: lambdaRole.id,
      policy: pulumi.all([state.arn, beacon.arn, instance.arn, logGroup.arn]).apply(([s, bc, inst, lg]) =>
        policyDoc([
          { Sid: "Logs", Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: `${lg}:*` },
          { Sid: "State", Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject"], Resource: [`${s}/state/*`, `${s}/history/*`] },
          { Sid: "Reads", Effect: "Allow", Action: ["s3:GetObject"], Resource: [`${s}/status/*`, `${s}/control/*`] },
          { Sid: "Beacon", Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject"], Resource: `${bc}/beacon/mode.json` },
          { Sid: "Describe", Effect: "Allow", Action: ["ec2:DescribeInstances"], Resource: "*" },
          { Sid: "StartStop", Effect: "Allow", Action: ["ec2:StartInstances", "ec2:StopInstances"], Resource: inst },
          {
            Sid: "Keys",
            Effect: "Allow",
            Action: ["ssm:GetParameter"],
            Resource: [
              `arn:aws:ssm:${region}:${c.accountId}:parameter${SSM_PREFIX}/beacon/*`,
              `arn:aws:ssm:${region}:${c.accountId}:parameter${SSM_PREFIX}/discord-error-webhook`,
            ],
          },
        ]),
      ),
    },
    o,
  );
  const controller = new aws.lambda.Function(
    `${p}-controller`,
    {
      name: `${p}-controller`,
      runtime: aws.lambda.Runtime.NodeJS24dX,
      architectures: ["arm64"],
      handler: "index.handler",
      code: new pulumi.asset.AssetArchive({ "index.mjs": new pulumi.asset.FileAsset(path.join(root, "build/aws/lambda/index.mjs")) }),
      role: lambdaRole.arn,
      memorySize: 256,
      timeout: 60,
      loggingConfig: { logFormat: "Text", logGroup: logGroup.name },
      environment: {
        variables: pulumi.all([state.bucket, beacon.bucket, instance.id, siteUrl]).apply(([sb, bb, iid, url]) => ({
          STATE_BUCKET: sb,
          BEACON_BUCKET: bb,
          INSTANCE_ID: iid,
          BEACON_KID: "beacon-1",
          BEACON_KEY_PARAM: `${SSM_PREFIX}/beacon/signing-key`,
          NOTIFY_WEBHOOK_PARAM: `${SSM_PREFIX}/discord-error-webhook`,
          // 公開 URL（要約の表示と、CloudFront 経由の準備完了の確認: /_jrabot/health）
          SITE_URL: url,
          ...(c.controller === undefined ? {} : { CONTROLLER_CONFIG: JSON.stringify(c.controller) }),
        })),
      },
      tags,
    },
    { ...o, dependsOn: [logGroup] },
  );
  const schedRole = new aws.iam.Role(
    `${p}-scheduler`,
    {
      assumeRolePolicy: policyDoc([{ Effect: "Allow", Principal: { Service: "scheduler.amazonaws.com" }, Action: "sts:AssumeRole" }]),
      tags,
    },
    o,
  );
  new aws.iam.RolePolicy(
    `${p}-scheduler-invoke`,
    {
      role: schedRole.id,
      policy: controller.arn.apply((a) => policyDoc([{ Effect: "Allow", Action: "lambda:InvokeFunction", Resource: a }])),
    },
    o,
  );
  new aws.scheduler.Schedule(
    `${p}-tick`,
    {
      name: `${p}-tick`,
      scheduleExpression: "rate(5 minutes)",
      flexibleTimeWindow: { mode: "OFF" },
      target: {
        arn: controller.arn,
        roleArn: schedRole.arn,
        input: JSON.stringify({ action: "tick" }),
        retryPolicy: { maximumRetryAttempts: 0 },
      },
    },
    // 初回の構築が終わってから動かす（VPC origin は EC2 が動いていないと作れない。先に動くと『制御を通さない起動』として止めてしまう）
    { ...o, dependsOn: [distribution, siteJson, ingressFromCloudFront] },
  );

  // 制御そのものの失敗の検知（制御が動かないと自動停止も通知も止まる）: Lambda のエラーが続く・定期実行が来ない → メール（SNS。購読の確認は本人）
  const alarmTopic = new aws.sns.Topic(`${p}-alarms`, { name: `${p}-alarms`, tags }, o);
  new aws.sns.TopicSubscription(
    `${p}-alarms-email`,
    { topic: alarmTopic.arn, protocol: "email", endpoint: c.budgetEmail ?? c.ownerEmail },
    o,
  );
  new aws.cloudwatch.MetricAlarm(
    `${p}-controller-errors`,
    {
      name: `${p}-controller-errors`,
      alarmDescription: "jra-bot: 制御の Lambda が失敗し続けている（自動停止が働かない可能性）",
      namespace: "AWS/Lambda",
      metricName: "Errors",
      dimensions: { FunctionName: controller.name },
      statistic: "Sum",
      period: 3600,
      evaluationPeriods: 1,
      threshold: 3,
      comparisonOperator: "GreaterThanOrEqualToThreshold",
      treatMissingData: "notBreaching",
      alarmActions: [alarmTopic.arn],
      okActions: [alarmTopic.arn],
      tags,
    },
    o,
  );
  new aws.cloudwatch.MetricAlarm(
    `${p}-controller-silent`,
    {
      name: `${p}-controller-silent`,
      alarmDescription: "jra-bot: 制御の定期実行が 1 時間来ていない（Scheduler の停止・権限の誤り）",
      namespace: "AWS/Lambda",
      metricName: "Invocations",
      dimensions: { FunctionName: controller.name },
      statistic: "Sum",
      period: 3600,
      evaluationPeriods: 1,
      threshold: 1,
      comparisonOperator: "LessThanThreshold",
      treatMissingData: "breaching",
      alarmActions: [alarmTopic.arn],
      okActions: [alarmTopic.arn],
      tags,
    },
    o,
  );

  // ホストで実行してよいコマンドだけの SSM ドキュメント（GitHub のロールに任意のシェル〔AWS-RunShellScript〕を渡さない）。引数は文字を限る
  const hostCommand = new aws.ssm.Document(
    `${p}-host-command`,
    {
      name: `${p}-host-command`,
      documentType: "Command",
      documentFormat: "JSON",
      content: JSON.stringify({
        schemaVersion: "2.2",
        description: "jra-bot: jrabot-host の deploy・backup・run-batch だけを実行する",
        parameters: {
          action: { type: "String", allowedValues: ["deploy", "backup", "run-batch"] },
          args: { type: "String", default: "", allowedPattern: "^[A-Za-z0-9=.,_:/ -]{0,600}$" },
          executionTimeout: { type: "String", default: "3600", allowedPattern: "^[0-9]{2,5}$" },
        },
        mainSteps: [
          {
            action: "aws:runShellScript",
            name: "jrabotHost",
            inputs: { timeoutSeconds: "{{ executionTimeout }}", runCommand: ["/opt/jrabot/bin/jrabot-host {{ action }} {{ args }}"] },
          },
        ],
      }),
      tags,
    },
    o,
  );

  // ---------------------------------------------------------------- GitHub Actions の OIDC（長期キーなし）
  const oidcArn: pulumi.Input<string> =
    c.githubOidcProviderArn ??
    new aws.iam.OpenIdConnectProvider(
      "github",
      { url: "https://token.actions.githubusercontent.com", clientIdLists: ["sts.amazonaws.com"], tags },
      o,
    ).arn;
  const trust = (sub: string): pulumi.Output<string> =>
    pulumi.output(oidcArn).apply((arn) =>
      policyDoc([
        {
          Effect: "Allow",
          Principal: { Federated: arn },
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: {
            StringEquals: {
              "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
              "token.actions.githubusercontent.com:sub": sub,
            },
          },
        },
      ]),
    );
  const ops = new aws.iam.Role(`${p}-gha-ops`, { assumeRolePolicy: trust(OPS_SUBJECT(c.githubOwner)), maxSessionDuration: 3600, tags }, o);
  new aws.iam.RolePolicy(
    `${p}-gha-ops-inline`,
    {
      role: ops.id,
      policy: pulumi.all([controller.arn, instance.arn, state.arn, hostCommand.arn]).apply(([fn, inst, s, doc]) =>
        policyDoc([
          { Sid: "Controller", Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: fn },
          // 専用のドキュメントだけ（任意のシェルは送れない）
          { Sid: "HostCommands", Effect: "Allow", Action: ["ssm:SendCommand"], Resource: [inst, doc] },
          { Sid: "CommandResult", Effect: "Allow", Action: ["ssm:GetCommandInvocation"], Resource: "*" },
          // 候補だけを置ける（正式な版への昇格はホストが deploy の成功後に行う）
          { Sid: "Release", Effect: "Allow", Action: ["s3:PutObject"], Resource: `${s}/control/release-candidate.json` },
          // secrets-init: 作るだけ（CLI は Overwrite=false。既にあれば ParameterAlreadyExists）。値を読む権限（GetParameter）は渡さない
          {
            Sid: "SecretsInit",
            Effect: "Allow",
            Action: ["ssm:PutParameter"],
            Resource: `arn:aws:ssm:${region}:${c.accountId}:parameter${SSM_PREFIX}/*`,
          },
        ]),
      ),
    },
    o,
  );
  let webPushRoleArn: pulumi.Output<string> | undefined;
  if (c.enableWebPush) {
    const push = new aws.iam.Role(
      `${p}-gha-web-push`,
      { assumeRolePolicy: trust(WEB_PUSH_SUBJECT(c.githubOwner)), maxSessionDuration: 3600, tags },
      o,
    );
    new aws.iam.RolePolicy(
      `${p}-gha-web-push-inline`,
      {
        role: push.id,
        policy: pulumi.all(repos.map((r) => r.arn)).apply((arns) =>
          policyDoc([
            { Sid: "Auth", Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: "*" },
            {
              Sid: "Push",
              Effect: "Allow",
              Action: [
                "ecr:BatchCheckLayerAvailability",
                "ecr:InitiateLayerUpload",
                "ecr:UploadLayerPart",
                "ecr:CompleteLayerUpload",
                "ecr:PutImage",
                "ecr:BatchGetImage",
              ],
              Resource: arns,
            },
          ]),
        ),
      },
      o,
    );
    webPushRoleArn = push.arn;
  }

  // ---------------------------------------------------------------- 予算の通知（強制停止ではない。請求データは数時間〜1 日遅れる）
  if (c.budgetEmail !== undefined) {
    new aws.budgets.Budget(
      `${p}-monthly`,
      {
        budgetType: "COST",
        limitAmount: c.budgetUsd.toFixed(2),
        limitUnit: "USD",
        timeUnit: "MONTHLY",
        notifications: [50, 80, 100].map((t) => ({
          comparisonOperator: "GREATER_THAN",
          threshold: t,
          thresholdType: "PERCENTAGE",
          notificationType: "ACTUAL",
          subscriberEmailAddresses: [c.budgetEmail ?? ""],
        })),
      },
      o,
    );
  }

  return {
    instanceId: instance.id,
    dataVolumeId: data.id,
    controllerFunction: controller.name,
    stateBucket: state.bucket,
    beaconUrl: pulumi.interpolate`https://${beacon.bucket}.s3.${region}.amazonaws.com/beacon/mode.json`,
    opsRoleArn: ops.arn,
    hostCommandDocument: hostCommand.name,
    webPushRoleArn,
    ecrRegistry,
    cognitoIssuer: issuer,
    cognitoClientId: client.id,
    siteUrl,
    distributionId: distribution.id,
    vpcOriginId: vpcOrigin.id,
  };
}

function createHashHex(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}
