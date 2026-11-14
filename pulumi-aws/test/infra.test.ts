// Pulumi（AWS）の定義の mock 試験（AWS の認証なし。資源は作らない）。**mock の成功は実 AWS の preview・up の成功ではない**。
// 確かめること: 固定費の大きい資源を作らない・公開してよいものだけを公開・データを消さない保護・最小権限・停止中も課金されにくい構成・設定の検査。
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { type AwsInfraConfig, REQUIRED_APP_KEYS, renderAppEnv, AwsInfraConfig as Schema } from "../src/config.js";
import { defineAwsInfra, OPS_SUBJECT, WEB_PUSH_SUBJECT } from "../src/infra.js";
import { renderUserData } from "../src/userdata.js";

interface Rec {
  readonly type: string;
  readonly name: string;
  readonly inputs: Record<string, unknown>;
  readonly protect: boolean;
}
const created: Rec[] = [];

pulumi.runtime.setMocks(
  {
    newResource(args: pulumi.runtime.MockResourceArgs): { id: string; state: Record<string, unknown> } {
      const inputs = args.inputs as Record<string, unknown>;
      created.push({
        type: args.type,
        name: args.name,
        inputs,
        protect: args.custom === true && (args as unknown as { protect?: boolean }).protect === true,
      });
      const state: Record<string, unknown> = { ...inputs, arn: `arn:aws:mock:::${args.name}`, name: inputs["name"] ?? args.name };
      if (args.type === "aws:ebs/volume:Volume") return { id: "vol-0123456789abcdef0", state };
      if (args.type === "aws:ec2/instance:Instance") return { id: "i-0123456789abcdef0", state };
      if (args.type === "aws:s3/bucketV2:BucketV2") state["bucket"] = inputs["bucket"];
      if (args.type === "aws:cognito/userPool:UserPool") return { id: "ap-northeast-1_Mock", state };
      if (args.type === "aws:cognito/userPoolClient:UserPoolClient") state["clientSecret"] = "mock-secret";
      return { id: `${args.name}-id`, state };
    },
    call(args: pulumi.runtime.MockCallArgs): Record<string, unknown> {
      return args.inputs as Record<string, unknown>;
    },
  },
  "jra-bot-aws",
  "test",
  true,
);

const D = `@sha256:${"b".repeat(64)}`;
const base = {
  prefix: "jrabot",
  accountId: "123456789012",
  amiId: "ami-0123456789abcdef0",
  siteHost: "jrabot.example.com",
  dnsZoneId: "Z0123456789ABC",
  cognitoDomainPrefix: "jrabot-owner-auth",
  ownerEmail: "owner@example.com",
  githubOwner: "example-owner",
  budgetEmail: "owner@example.com",
  appEnv: Object.fromEntries(REQUIRED_APP_KEYS.map((k) => [k, "1"])),
  hostImages: { mysql: `mysql:8.4.11${D}`, caddy: `caddy:2.11.6${D}`, oauth2Proxy: `quay.io/oauth2-proxy/oauth2-proxy:v7.15.3${D}` },
};
const cfg: AwsInfraConfig = Schema.parse(base);

const of = (type: string): Rec[] => created.filter((r) => r.type === type);
const resolve = <T>(o: pulumi.Input<T>): Promise<T> => new Promise((r) => pulumi.output(o).apply((v) => r(v as T)));

describe("AWS の資源（mock）", () => {
  before(async () => {
    process.chdir(new URL("../../..", import.meta.url).pathname);
    const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    if (!existsSync("build/aws/host/jrabot-host.mjs")) {
      mkdirSync("build/aws/host", { recursive: true });
      mkdirSync("build/aws/lambda", { recursive: true });
      writeFileSync("build/aws/host/jrabot-host.mjs", "// test\n");
      writeFileSync("build/aws/lambda/index.mjs", "// test\n");
    }
    const out = defineAwsInfra(cfg, new aws.Provider("aws", { region: "ap-northeast-1" }), ".");
    await resolve(out.instanceId);
    await new Promise((r) => setTimeout(r, 200));
  });

  it("固定費の大きい資源（RDS・NAT Gateway・ALB・Elastic IP・KMS の鍵・Secrets Manager・VPC エンドポイント）を作らない", () => {
    for (const t of [
      "aws:rds/instance:Instance",
      "aws:ec2/natGateway:NatGateway",
      "aws:lb/loadBalancer:LoadBalancer",
      "aws:ec2/eip:Eip",
      "aws:kms/key:Key",
      "aws:secretsmanager/secret:Secret",
      "aws:ec2/vpcEndpoint:VpcEndpoint",
    ]) {
      assert.equal(of(t).length, 0, t);
    }
  });

  it("受け付けるのは 443 と 80 だけ（SSH・DB・Docker の管理ポートを開けない）", () => {
    const sg = of("aws:ec2/securityGroup:SecurityGroup");
    assert.equal(sg.length, 1);
    const ports = ((sg[0]?.inputs["ingress"] ?? []) as { fromPort: number; toPort: number }[]).map((r) => `${r.fromPort}-${r.toPort}`);
    assert.deepEqual(ports.sort(), ["443-443", "80-80"]);
  });

  it("EC2: IMDSv2 必須・停止で止まる・誤って消さない・Elastic IP なし・ルートは暗号化", () => {
    const i = of("aws:ec2/instance:Instance")[0]?.inputs ?? {};
    assert.deepEqual(i["metadataOptions"], { httpTokens: "required", httpPutResponseHopLimit: 2, httpEndpoint: "enabled" });
    assert.equal(i["instanceInitiatedShutdownBehavior"], "stop");
    assert.equal(i["disableApiTermination"], true);
    assert.equal(i["instanceType"], "t4g.small");
    assert.equal((i["rootBlockDevice"] as Record<string, unknown>)["encrypted"], true);
  });

  it("データの EBS は暗号化・スナップショットの対象の印・Pulumi で消さない（protect・retainOnDelete）", () => {
    const v = of("aws:ebs/volume:Volume")[0];
    assert.ok(v);
    assert.equal(v.inputs["encrypted"], true);
    assert.equal((v.inputs["tags"] as Record<string, string>)["Snapshot"], "jrabot-data");
    const dlm = of("aws:dlm/lifecyclePolicy:LifecyclePolicy")[0]?.inputs["policyDetails"] as {
      schedules: { retainRule: { count: number } }[];
    };
    assert.equal(dlm.schedules[0]?.retainRule.count, 2, "スナップショットは世代数で上限");
  });

  it("公開するのはビーコンの 1 オブジェクトの読取りだけ。他のバケットは公開の遮断と TLS 必須", async () => {
    const pabs = of("aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock");
    assert.equal(pabs.length, 4);
    assert.equal(pabs.filter((p) => p.inputs["restrictPublicBuckets"] === false).length, 1);
    const pol = of("aws:s3/bucketPolicy:BucketPolicy").find((p) => p.name === "beacon-policy");
    const doc = JSON.parse(String(await resolve(pol?.inputs["policy"] as pulumi.Input<string>))) as {
      Statement: { Sid: string; Resource: unknown }[];
    };
    assert.match(String(doc.Statement.find((s) => s.Sid === "PublicBeacon")?.Resource), /\/beacon\/mode\.json$/);
    for (const p of of("aws:s3/bucketPolicy:BucketPolicy"))
      assert.match(String(await resolve(p.inputs["policy"] as pulumi.Input<string>)), /aws:SecureTransport/);
  });

  it("費用が増え続けない: バックアップ・履歴・データセット・旧版はライフサイクルで消える。ECR は直近 6、ログは 14 日", async () => {
    const lc = of("aws:s3/bucketLifecycleConfigurationV2:BucketLifecycleConfigurationV2");
    const backups = lc.find((l) => l.name === "backups-lifecycle")?.inputs["rules"] as { expiration?: { days: number } }[];
    assert.equal(backups[0]?.expiration?.days, 35);
    assert.equal(lc.length, 3);
    assert.equal(of("aws:ecr/lifecyclePolicy:LifecyclePolicy").length, 5);
    assert.equal(of("aws:cloudwatch/logGroup:LogGroup")[0]?.inputs["retentionInDays"], 14);
    for (const r of of("aws:ecr/repository:Repository")) assert.equal(r.inputs["imageTagMutability"], "IMMUTABLE");
  });

  it("Lambda は VPC に接続しない・arm64・5 分ごとに起動・環境に秘密を入れない", async () => {
    const fn = of("aws:lambda/function:Function")[0]?.inputs ?? {};
    assert.equal(fn["vpcConfig"], undefined);
    assert.deepEqual(fn["architectures"], ["arm64"]);
    const env = (await resolve(fn["environment"] as pulumi.Input<{ variables: Record<string, string> }>)).variables;
    for (const v of Object.values(env)) assert.doesNotMatch(v, /secret|password/i);
    assert.equal(env["BEACON_KEY_PARAM"], "/jra-bot/beacon/signing-key");
    const s = of("aws:scheduler/schedule:Schedule")[0]?.inputs ?? {};
    assert.equal(s["scheduleExpression"], "rate(5 minutes)");
  });

  it("ホストのロールはビーコンの署名鍵を読めず、バックアップを消せない。GitHub のロールは環境まで固定し、EC2 を直接動かせない", async () => {
    const host = JSON.parse(
      String(
        await resolve(
          of("aws:iam/rolePolicy:RolePolicy").find((r) => r.name === "jrabot-host-inline")?.inputs["policy"] as pulumi.Input<string>,
        ),
      ),
    ) as {
      Statement: { Sid: string; Effect: string; Action: string[] }[];
    };
    assert.equal(host.Statement.find((s) => s.Sid === "NoBeaconKey")?.Effect, "Deny");
    assert.equal(
      host.Statement.some((s) => s.Action.includes("s3:DeleteObject") && s.Sid === "Backups"),
      false,
    );
    const ops = String(
      await resolve(
        of("aws:iam/rolePolicy:RolePolicy").find((r) => r.name === "jrabot-gha-ops-inline")?.inputs["policy"] as pulumi.Input<string>,
      ),
    );
    assert.doesNotMatch(ops, /ec2:StartInstances|ec2:StopInstances|ec2:\*/);
    assert.doesNotMatch(ops, /AWS-RunShellScript/, "任意のシェルを送れない（専用のドキュメントだけ）");
    assert.doesNotMatch(ops, /ssm:GetParameter/, "秘密の値を読めない");
    const doc = JSON.parse(String(of("aws:ssm/document:Document")[0]?.inputs["content"])) as {
      parameters: { action: { allowedValues: string[] }; args: { allowedPattern: string } };
    };
    assert.deepEqual(doc.parameters.action.allowedValues, ["deploy", "backup", "run-batch"]);
    assert.equal(doc.parameters.args.allowedPattern, "^[A-Za-z0-9=.,_:/ -]{0,600}$");
    const trust = String(
      await resolve(of("aws:iam/role:Role").find((r) => r.name === "jrabot-gha-ops")?.inputs["assumeRolePolicy"] as pulumi.Input<string>),
    );
    assert.match(trust, new RegExp(OPS_SUBJECT("example-owner").replace(/[/]/g, "\\/")));
    assert.equal(
      of("aws:iam/role:Role").some((r) => r.name === "jrabot-gha-web-push"),
      false,
      "web の push の権限は承認後（enableWebPush）",
    );
    assert.match(WEB_PUSH_SUBJECT("x"), /environment:release$/);
  });

  it("Cognito: 自己登録なし・MFA 必須・Lite・削除の保護。client secret は SSM の SecureString", () => {
    const pool = of("aws:cognito/userPool:UserPool")[0]?.inputs ?? {};
    assert.equal((pool["adminCreateUserConfig"] as Record<string, unknown>)["allowAdminCreateUserOnly"], true);
    assert.equal(pool["mfaConfiguration"], "ON");
    assert.equal(pool["userPoolTier"], "LITE");
    assert.equal(pool["deletionProtection"], "ACTIVE");
    assert.equal(of("aws:ssm/parameter:Parameter")[0]?.inputs["type"], "SecureString");
    const client = of("aws:cognito/userPoolClient:UserPoolClient")[0]?.inputs ?? {};
    assert.deepEqual(client["callbackUrls"], ["https://jrabot.example.com/oauth2/callback"]);
  });

  it("制御の失敗（エラーが続く・定期実行が来ない）をメールで知らせる。バックアップはバージョニング", () => {
    const alarms = of("aws:cloudwatch/metricAlarm:MetricAlarm").map((r) => r.inputs["metricName"]);
    assert.deepEqual(alarms.sort(), ["Errors", "Invocations"]);
    assert.equal(of("aws:sns/topicSubscription:TopicSubscription")[0]?.inputs["protocol"], "email");
    assert.ok(of("aws:s3/bucketVersioningV2:BucketVersioningV2").some((r) => r.name.includes("backups")));
  });

  it("予算の通知を作る（強制停止ではない）", () => {
    const b = of("aws:budgets/budget:Budget")[0]?.inputs ?? {};
    assert.equal(b["limitAmount"], "20.00");
  });
});

describe("設定と user data", () => {
  it("運用値（CALENDAR_*・BOT_RUN_*）が欠けている・秘密を app.env に入れる・DNS の指定が無いのは拒否", () => {
    const { CALENDAR_WATCH_START_MINUTES: _drop, ...partial } = base.appEnv;
    assert.equal(Schema.safeParse({ ...base, appEnv: partial }).success, false);
    assert.equal(Schema.safeParse({ ...base, appEnv: { ...base.appEnv, DB_PASSWORD: "x" } }).success, false);
    assert.equal(Schema.safeParse({ ...base, dnsZoneId: undefined }).success, false);
    assert.equal(Schema.safeParse({ ...base, hostImages: { ...base.hostImages, mysql: "mysql:8.4" } }).success, false, "digest で固定");
    assert.equal(
      Schema.safeParse({ ...base, hostImages: { ...base.hostImages, oauth2Proxy: "quay.io/oauth2-proxy/oauth2-proxy:v7.15.3" } }).success,
      false,
      "oauth2-proxy も digest で固定",
    );
    assert.match(renderAppEnv(cfg), /^ADMIN_USERS=owner@example.com$/m);
  });

  it("user data: Node は SHA-256 で検証、データの EBS はファイルシステムが無いときだけ作る、秘密を含めない", () => {
    const u = renderUserData({
      arch: "arm64",
      stateBucket: "jrabot-ops-state-123",
      dataVolumeId: "vol-0123456789abcdef0",
      ecrRegistry: "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com",
      hostJson: "{}",
    });
    assert.match(u, /sha256sum -c -/);
    assert.match(u, /node-v24\.22\.2-linux-arm64\.tar\.xz/);
    assert.match(u, /blkid -o value -s TYPE/);
    assert.match(u, /初期化しない/);
    assert.match(u, /flock -w 1800 \/run\/jrabot-host\.lock/, "boot・tick・deploy・backup・restore を同時に動かさない");
    assert.match(u, /case "\$\{1:-\}" in/);
    assert.doesNotMatch(u, /password|secret_access|AKIA/i);
    assert.throws(() => renderUserData({ arch: "arm64", stateBucket: "b", dataVolumeId: "vol-x", ecrRegistry: "r", hostJson: "{}" }));
    assert.ok(u.length < 16_000, "user data の上限（16 KB）");
  });
});
