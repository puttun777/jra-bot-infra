// AWS の資源（東京リージョン）。**適用（pulumi up）は本人の承認後**。費用の内訳は docs/CLOUD_COSTS.md §12、設計は docs/AWS_ARCHITECTURE.md。
// 固定費の大きいもの（RDS・NAT Gateway・ALB・Elastic IP・KMS の顧客管理の鍵・Secrets Manager・VPC エンドポイント）は使わない。
// Lambda は VPC に接続しない（NAT が要らない）。データの EBS は Pulumi の protect と retainOnDelete で誤って消さない。
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
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
  readonly siteUrl: string;
  readonly zoneNameServers: pulumi.Output<string[]> | undefined;
}

export function defineAwsInfra(c: AwsInfraConfig, provider: aws.Provider, root = "."): AwsOutputs {
  const o = { provider };
  const p = c.prefix;
  const tags = { project: "jra-bot", managedBy: "pulumi" };
  const region = "ap-northeast-1";
  const ecrRegistry = `${c.accountId}.dkr.ecr.${region}.amazonaws.com`;

  // ---------------------------------------------------------------- ネットワーク（パブリックの 1 サブネット。NAT なし）
  const vpc = new aws.ec2.Vpc(`${p}-vpc`, { cidrBlock: "10.80.0.0/16", enableDnsHostnames: true, enableDnsSupport: true, tags }, o);
  const igw = new aws.ec2.InternetGateway(`${p}-igw`, { vpcId: vpc.id, tags }, o);
  const subnet = new aws.ec2.Subnet(
    `${p}-public`,
    { vpcId: vpc.id, cidrBlock: "10.80.1.0/24", availabilityZone: c.availabilityZone, mapPublicIpOnLaunch: true, tags },
    o,
  );
  const rt = new aws.ec2.RouteTable(`${p}-rt`, { vpcId: vpc.id, routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: igw.id }], tags }, o);
  new aws.ec2.RouteTableAssociation(`${p}-rta`, { subnetId: subnet.id, routeTableId: rt.id }, o);
  // 受け付けるのは HTTPS（と証明書の取得・リダイレクトの HTTP）だけ。SSH・DB・Docker の管理ポートは開けない（管理は SSM）
  const sg = new aws.ec2.SecurityGroup(
    `${p}-web`,
    {
      vpcId: vpc.id,
      description: "jra-bot: HTTPS and ACME HTTP only (no SSH, no DB)",
      ingress: [
        { protocol: "tcp", fromPort: 443, toPort: 443, cidrBlocks: ["0.0.0.0/0"], description: "HTTPS" },
        { protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"], description: "ACME HTTP-01 and redirect" },
      ],
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
      { ...o, protect: name !== "beacon" },
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
  for (const [n, b] of [
    ["ops-state", state],
    ["models", models],
    ["backups", backups],
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
  const client = new aws.cognito.UserPoolClient(
    `${p}-web`,
    {
      userPoolId: pool.id,
      generateSecret: true,
      allowedOauthFlowsUserPoolClient: true,
      allowedOauthFlows: ["code"],
      allowedOauthScopes: ["openid", "email"],
      supportedIdentityProviders: ["COGNITO"],
      callbackUrls: [`https://${c.siteHost}/oauth2/callback`],
      logoutUrls: [`https://${c.siteHost}/`],
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

  // ---------------------------------------------------------------- DNS（任意で Route 53 のホストゾーンを作る。A レコードは制御の Lambda が起動のたびに書く）
  const zone = c.createZone
    ? new aws.route53.Zone(`${p}-zone`, { name: c.zoneName ?? c.siteHost, forceDestroy: false, tags }, { ...o, protect: true })
    : undefined;
  const zoneId: pulumi.Input<string> = zone?.zoneId ?? c.dnsZoneId ?? "";

  // ---------------------------------------------------------------- EC2 とデータの EBS
  const data = new aws.ebs.Volume(
    `${p}-data`,
    {
      availabilityZone: c.availabilityZone,
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
  const hostJson = pulumi.all([state.bucket, backups.bucket, models.bucket, issuer, client.id]).apply(([sb, bb, mb, iss, cid]) =>
    JSON.stringify({
      state_bucket: sb,
      backup_bucket: bb,
      models_bucket: mb,
      ssm_prefix: SSM_PREFIX,
      ecr_registry: ecrRegistry,
      site_host: c.siteHost,
      cognito_issuer: iss,
      cognito_client_id: cid,
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
      associatePublicIpAddress: true, // Elastic IP は持たない（停止中に課金されないように。IP は起動のたびに変わり DNS で追う）
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
    // AMI・user data の変更でインスタンスを作り直さない（データは別の EBS。作り直しは本人の判断で）
    { ...o, ignoreChanges: ["ami", "userData"] },
  );
  new aws.ec2.VolumeAttachment(
    `${p}-data-attach`,
    { deviceName: "/dev/sdf", volumeId: data.id, instanceId: instance.id, stopInstanceBeforeDetaching: true },
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
      policy: pulumi.all([state.arn, beacon.arn, instance.arn, logGroup.arn, pulumi.output(zoneId)]).apply(([s, bc, inst, lg, zid]) =>
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
          ...(zid === ""
            ? []
            : [
                {
                  Sid: "Dns",
                  Effect: "Allow",
                  Action: ["route53:ChangeResourceRecordSets"],
                  Resource: `arn:aws:route53:::hostedzone/${zid}`,
                  Condition: {
                    "ForAllValues:StringEquals": {
                      "route53:ChangeResourceRecordSetsNormalizedRecordNames": [c.siteHost],
                      "route53:ChangeResourceRecordSetsRecordTypes": ["A"],
                    },
                  },
                },
              ]),
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
        variables: pulumi.all([state.bucket, beacon.bucket, instance.id, pulumi.output(zoneId)]).apply(([sb, bb, iid, zid]) => ({
          STATE_BUCKET: sb,
          BEACON_BUCKET: bb,
          INSTANCE_ID: iid,
          BEACON_KID: "beacon-1",
          BEACON_KEY_PARAM: `${SSM_PREFIX}/beacon/signing-key`,
          NOTIFY_WEBHOOK_PARAM: `${SSM_PREFIX}/discord-error-webhook`,
          SITE_URL: `https://${c.siteHost}`,
          ...(zid === "" ? {} : { DNS_ZONE_ID: zid, DNS_NAME: c.siteHost }),
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
    o,
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
    siteUrl: `https://${c.siteHost}`,
    zoneNameServers: zone?.nameServers,
  };
}

function createHashHex(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}
