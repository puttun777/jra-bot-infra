// Pulumi の定義の mock 試験（GCP 認証なし。資源は作らない）。Terraform の試験（terraform/tests/base・deploy.tftest.hcl）と同じ性質を検査する。
// **mock の成功は実 GCP の preview の成功ではない**（docs/PULUMI_MIGRATION.md §5）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import * as pulumi from "@pulumi/pulumi";
import { parseConfig, REQUIRED_RUNTIME_KEYS, readConfig } from "../src/config.js";
import {
  botJobs,
  DEPLOYER_PERMISSIONS,
  defineInfra,
  IGNORE,
  OPS_CONTROLLER_PERMISSIONS,
  SECRETS,
  TF_ROLES,
  WEB_RELEASE_WORKFLOW,
  WIF_WORKFLOWS,
} from "../src/infra.js";

interface Rec {
  readonly type: string;
  readonly name: string;
  readonly inputs: Record<string, unknown>;
}
interface OptRec {
  readonly type: string;
  readonly name: string;
  readonly ignoreChanges: readonly string[];
}

const created: Rec[] = [];

pulumi.runtime.setMocks(
  {
    newResource(args: pulumi.runtime.MockResourceArgs): { id: string; state: Record<string, unknown> } {
      const inputs = args.inputs as Record<string, unknown>;
      created.push({ type: args.type, name: args.name, inputs });
      const state: Record<string, unknown> = { ...inputs, name: inputs["name"] ?? args.name };
      if (args.type === "gcp:serviceaccount/account:Account") state["email"] = `${String(inputs["accountId"])}@p.iam.gserviceaccount.com`;
      if (args.type === "gcp:sql/databaseInstance:DatabaseInstance") state["privateIpAddress"] = "10.0.0.3";
      return { id: `${args.name}-id`, state };
    },
    call(args: pulumi.runtime.MockCallArgs): Record<string, unknown> {
      return args.inputs as Record<string, unknown>;
    },
  },
  "jra-bot",
  "test",
  true,
);

const DIGEST = `@sha256:${"a".repeat(64)}`;
const img = (n: string): string => `asia-northeast1-docker.pkg.dev/proj-1234/jra-bot/${n}${DIGEST}`;
const RUNTIME = Object.fromEntries(REQUIRED_RUNTIME_KEYS.map((k) => [k, "1"]));
const BASE = { projectId: "proj-1234", projectNumber: "123456789012" };
const DEPLOY = {
  ...BASE,
  allowedUsers: ["me@example.com"],
  releaseImages: {
    dashboard: img("dashboard"),
    ingest: img("ingest"),
    bot: img("bot"),
    db_migration: img("db-migration"),
    ml_train: img("ml-train"),
  },
  appRuntime: RUNTIME,
};

/** 資源の登録が止まるまで待つ（20ms ごとに数え、5 回続けて増えなければ終わり。遅い環境での数え漏らしを防ぐ）。 */
async function settle(): Promise<void> {
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 500 && stable < 5; i++) {
    await new Promise((r) => setTimeout(r, 20));
    if (created.length === last) stable++;
    else {
      stable = 0;
      last = created.length;
    }
  }
}

async function define(raw: unknown): Promise<{ res: Rec[]; opts: OptRec[] }> {
  created.length = 0;
  const opts: OptRec[] = [];
  const t: pulumi.ResourceTransformation = (a) => {
    opts.push({ type: a.type, name: a.name, ignoreChanges: a.opts.ignoreChanges ?? [] });
    return undefined;
  };
  defineInfra(parseConfig(raw), undefined, [t]);
  await settle();
  return { res: [...created], opts };
}

const ofType = (res: readonly Rec[], type: string): Rec[] => res.filter((r) => r.type === type);
const one = (res: readonly Rec[], type: string, name: string): Rec => {
  const r = res.find((x) => x.type === type && x.name === name);
  assert.ok(r, `${type} ${name} が無い`);
  return r;
};
const rec = (v: unknown): Record<string, unknown> => {
  assert.ok(typeof v === "object" && v !== null && !Array.isArray(v), "object");
  return v as Record<string, unknown>;
};
const arr = (v: unknown): unknown[] => {
  assert.ok(Array.isArray(v), "array");
  return v;
};

describe("config (variables.tf と同じ検証)", () => {
  it("defaults and digest-only images", () => {
    const c = parseConfig(BASE);
    assert.equal(c.region, "asia-northeast1");
    assert.equal(c.dbTier, "db-g1-small");
    assert.equal(c.releaseImages, null);
    assert.throws(
      () => parseConfig({ ...DEPLOY, releaseImages: { ...DEPLOY.releaseImages, bot: "asia-northeast1-docker.pkg.dev/p/r/bot:latest" } }),
      /digest/,
    );
  });
  it("app_runtime requires every operational key and unknown keys are rejected", () => {
    const { BOT_RUN_LEASE_SECONDS: _omit, ...partial } = RUNTIME;
    assert.throws(() => parseConfig({ ...DEPLOY, appRuntime: partial }), /app_runtime/);
    assert.throws(() => parseConfig({ ...BASE, bogus: 1 }), /設定が不正/);
    assert.throws(() => parseConfig({ ...BASE, allowedUsers: ["not-an-email"] }), /allowedUsers/);
  });
  it("errors do not echo values", () => {
    assert.throws(
      () => parseConfig({ ...BASE, projectId: "SECRET-VALUE-XYZ" }),
      (e: unknown) => e instanceof Error && !e.message.includes("SECRET-VALUE-XYZ"),
    );
  });
});

describe("readConfig (stack の設定は文字列。型ごとに読む)", () => {
  const cfg = (m: Record<string, string>) => readConfig((k) => m[k]);
  it("plain strings stay strings (a numeric project number is not turned into a number)", () => {
    const c = cfg({
      projectId: "proj-1234",
      projectNumber: "123456789012",
      tenantId: "1",
      schedulerResumeOnCreate: "false",
      allowedUsers: '["me@example.com"]',
    });
    assert.equal(c.projectNumber, "123456789012");
    assert.equal(c.tenantId, 1);
    assert.equal(c.schedulerResumeOnCreate, false);
    assert.deepEqual(c.allowedUsers, ["me@example.com"]);
  });
  it("bad numbers, booleans and JSON are reported by key without the value", () => {
    assert.throws(() => cfg({ ...BASE, tenantId: "1.5" }), /tenantId/);
    assert.throws(() => cfg({ ...BASE, schedulerResumeOnCreate: "yes" }), /schedulerResumeOnCreate/);
    assert.throws(
      () => cfg({ ...BASE, appRuntime: "{SECRET-LIKE" }),
      (e: unknown) => e instanceof Error && e.message.includes("appRuntime") && !e.message.includes("SECRET-LIKE"),
    );
  });
  it("admin users must be allowed users (variables.tf)", () => {
    assert.throws(() => parseConfig({ ...BASE, allowedUsers: ["a@example.com"], adminUsers: ["b@example.com"] }), /adminUsers/);
    assert.equal(parseConfig({ ...BASE, allowedUsers: ["a@example.com"], adminUsers: ["a@example.com"] }).adminUsers.length, 1);
  });
});

describe("base (deploy 無効。base.tftest.hcl)", () => {
  let res: Rec[] = [];
  before(async () => {
    res = (await define(BASE)).res;
  });

  it("no Cloud Run, no Scheduler before release images and runtime are given", () => {
    assert.equal(ofType(res, "gcp:cloudrunv2/service:Service").length, 0);
    assert.equal(ofType(res, "gcp:cloudrunv2/job:Job").length, 0);
    assert.equal(ofType(res, "gcp:cloudscheduler/job:Job").length, 0);
  });
  it("buckets: ops_state and model_store are private and versioned, only the beacon bucket is public-read", () => {
    for (const n of ["ops-state", "model-store"]) {
      const b = one(res, "gcp:storage/bucket:Bucket", n);
      assert.equal(b.inputs["publicAccessPrevention"], "enforced");
      assert.equal(rec(b.inputs["versioning"])["enabled"], true);
      assert.equal(b.inputs["forceDestroy"], false);
    }
    const pub = ofType(res, "gcp:storage/bucketIAMMember:BucketIAMMember").filter((m) => m.inputs["member"] === "allUsers");
    assert.deepEqual(
      pub.map((m) => m.name),
      ["beacon-public-read"],
    );
    assert.equal(pub[0]?.inputs["bucket"], "proj-1234-mode-beacon");
  });
  it("Cloud SQL: no public IP, ENCRYPTED_ONLY, deletion protection, Enterprise db-g1-small", () => {
    const s = rec(one(res, "gcp:sql/databaseInstance:DatabaseInstance", "db").inputs["settings"]);
    const ip = rec(s["ipConfiguration"]);
    assert.equal(ip["ipv4Enabled"], false);
    assert.equal(ip["sslMode"], "ENCRYPTED_ONLY");
    assert.equal(s["edition"], "ENTERPRISE");
    assert.equal(s["tier"], "db-g1-small");
    assert.equal(s["deletionProtectionEnabled"], true);
    assert.equal(one(res, "gcp:sql/databaseInstance:DatabaseInstance", "db").inputs["deletionProtection"], true);
    assert.equal(s["activationPolicy"], "ALWAYS"); // 作成時だけ（以後は ignoreChanges）
  });
  it("DB users are not managed by Pulumi (passwords never enter the state: PULUMI_MIGRATION §3)", () => {
    assert.equal(ofType(res, "gcp:sql/user:User").length, 0);
  });
  it("secrets: 11 names, no secret versions (values are never managed)", () => {
    const s = ofType(res, "gcp:secretmanager/secret:Secret");
    assert.equal(s.length, 11);
    assert.deepEqual(s.map((x) => x.inputs["secretId"]).sort(), [...SECRETS].sort());
    assert.equal(ofType(res, "gcp:secretmanager/secretVersion:SecretVersion").length, 0);
  });
  it("WIF: only this infra repository, each workflow bound to main", () => {
    const p = one(res, "gcp:iam/workloadIdentityPoolProvider:WorkloadIdentityPoolProvider", "github");
    assert.equal(p.inputs["attributeCondition"], 'assertion.repository == "puttun777/jra-bot-infra"');
    const binds = ofType(res, "gcp:serviceaccount/iAMMember:IAMMember").filter((m) => m.name.startsWith("wif-"));
    assert.equal(binds.length, Object.keys(WIF_WORKFLOWS).length);
    for (const b of binds) {
      assert.equal(b.inputs["role"], "roles/iam.workloadIdentityUser");
      assert.match(
        String(b.inputs["member"]),
        /^principalSet:\/\/iam\.googleapis\.com\/.+\/attribute\.workflow_ref\/puttun777\/jra-bot-infra\/\.github\/workflows\/[a-z-]+\.yml@refs\/heads\/main$/,
      );
    }
  });
  it("WIF attribute mapping, the infra SA roles and actAs grants are exactly the Terraform ones", () => {
    const p = one(res, "gcp:iam/workloadIdentityPoolProvider:WorkloadIdentityPoolProvider", "github");
    assert.deepEqual(p.inputs["attributeMapping"], {
      "google.subject": "assertion.sub",
      "attribute.repository": "assertion.repository",
      "attribute.ref": "assertion.ref",
      "attribute.workflow_ref": "assertion.workflow_ref",
      "attribute.job_workflow_ref": "assertion.job_workflow_ref",
      "attribute.environment": "assertion.environment",
    });
    const tfRoles = ofType(res, "gcp:projects/iAMMember:IAMMember")
      .filter((m) => m.name.startsWith("tf-"))
      .map((m) => String(m.inputs["role"]))
      .sort();
    assert.equal(tfRoles.length, 15);
    assert.ok(tfRoles.every((r) => r.startsWith("roles/") && !["roles/owner", "roles/editor"].includes(r)));
    const actAs = ofType(res, "gcp:serviceaccount/iAMMember:IAMMember")
      .filter((m) => m.inputs["role"] === "roles/iam.serviceAccountUser")
      .map((m) => m.name)
      .sort();
    assert.deepEqual(actAs, [
      "deploy-act-as-bot",
      "deploy-act-as-dashboard",
      "deploy-act-as-dbmigration",
      "deploy-act-as-ingest",
      "deploy-act-as-mltrain",
      "ops-act-as-dashboard",
      "ops-act-as-dbmigration",
      "ops-act-as-ingest",
      "tf-act-as-bot",
      "tf-act-as-dashboard",
      "tf-act-as-dbmigration",
      "tf-act-as-gha-deploy",
      "tf-act-as-gha-ops",
      "tf-act-as-gha-tf",
      "tf-act-as-ingest",
      "tf-act-as-mltrain",
      "tf-act-as-scheduler",
    ]);
  });
  it("roles: no owner/editor, no setIamPolicy, no run.jobs.run; ops can stop SQL and pause Scheduler", () => {
    for (const r of TF_ROLES) assert.ok(!["roles/owner", "roles/editor"].includes(r));
    for (const p of [...OPS_CONTROLLER_PERMISSIONS, ...DEPLOYER_PERMISSIONS]) {
      assert.doesNotMatch(p, /setIamPolicy|iam\.serviceAccounts\.(create|delete)/);
      assert.notEqual(p, "run.jobs.run");
    }
    assert.ok(OPS_CONTROLLER_PERMISSIONS.includes("cloudsql.instances.update"));
    assert.ok(OPS_CONTROLLER_PERMISSIONS.includes("cloudscheduler.jobs.pause"));
    const roles = ofType(res, "gcp:projects/iAMMember:IAMMember").map((m) => m.inputs["role"]);
    assert.ok(!roles.includes("roles/owner") && !roles.includes("roles/editor"));
  });
  it("exactly two public grants in all IAM resources (beacon read, ingest invoker via deploy only)", () => {
    const pub = res.filter(
      (r) =>
        /(Iam|IAM)(Member|Binding)$/.test(r.type.split(":").pop() ?? "") &&
        ["allUsers", "allAuthenticatedUsers"].includes(String(r.inputs["member"])),
    );
    assert.deepEqual(
      pub.map((r) => r.name),
      ["beacon-public-read"],
    );
  });
  it("prefix-limited bucket grants keep their IAM conditions (Terraform と同じ式)", () => {
    const cond = (n: string): unknown => rec(one(res, "gcp:storage/bucketIAMMember:BucketIAMMember", n).inputs["condition"])["expression"];
    assert.equal(cond("ops-state-agent-write"), 'resource.name.startsWith("projects/_/buckets/proj-1234-ops-state/objects/agent/")');
    assert.equal(
      cond("model-store-bot-datasets"),
      'resource.name.startsWith("projects/_/buckets/proj-1234-model-store/objects/datasets/")',
    );
    assert.equal(cond("ops-state-deploy-state"), 'resource.name.startsWith("projects/_/buckets/proj-1234-ops-state/objects/state/")');
    assert.equal(cond("ops-state-deploy-history"), 'resource.name.startsWith("projects/_/buckets/proj-1234-ops-state/objects/history/")');
    assert.equal(
      one(res, "gcp:storage/bucketIAMMember:BucketIAMMember", "ops-state-deploy-history").inputs["role"],
      "roles/storage.objectCreator",
    );
  });
  it("secret access is exactly the Terraform table (13 grants)", () => {
    const got = ofType(res, "gcp:secretmanager/secretIamMember:SecretIamMember")
      .map((r) => `${r.name}=${String(r.inputs["member"]).split("@")[0]}`)
      .sort();
    assert.deepEqual(got, [
      "access-agent-kek-ingest=serviceAccount:sa-ingest",
      "access-beacon-signing-key-gha-ops=serviceAccount:sa-gha-ops",
      "access-db-app-password-dashboard=serviceAccount:sa-dashboard",
      "access-db-bot-password-bot=serviceAccount:sa-bot",
      "access-db-ingest-password-ingest=serviceAccount:sa-ingest",
      "access-db-migrate-password-dbmigration=serviceAccount:sa-dbmigration",
      "access-db-mltrain-password-mltrain=serviceAccount:sa-mltrain",
      "access-discord-error-webhook-bot=serviceAccount:sa-bot",
      "access-discord-error-webhook-gha-ops=serviceAccount:sa-gha-ops",
      "access-discord-webhook-bot=serviceAccount:sa-bot",
      "access-ingest-token-pepper-dashboard=serviceAccount:sa-dashboard",
      "access-ingest-token-pepper-ingest=serviceAccount:sa-ingest",
      "access-model-signing-key-mltrain=serviceAccount:sa-mltrain",
    ]);
  });
  it("no API is disabled on destroy", () => {
    const apis = ofType(res, "gcp:projects/service:Service");
    assert.equal(apis.length, 14);
    for (const a of apis) assert.equal(a.inputs["disableOnDestroy"], false);
  });
});

describe("deploy (deploy.tftest.hcl)", () => {
  let res: Rec[] = [];
  let opts: OptRec[] = [];
  before(async () => {
    ({ res, opts } = await define(DEPLOY));
  });

  it("services start INTERNAL (stopped side), dashboard has IAP, images are digests", () => {
    for (const n of ["dashboard", "ingest"]) {
      const s = one(res, "gcp:cloudrunv2/service:Service", n);
      assert.equal(s.inputs["ingress"], "INGRESS_TRAFFIC_INTERNAL_ONLY");
      const c = rec(arr(rec(s.inputs["template"])["containers"])[0]);
      assert.match(String(c["image"]), /@sha256:[0-9a-f]{64}$/);
    }
    assert.equal(one(res, "gcp:cloudrunv2/service:Service", "dashboard").inputs["iapEnabled"], true);
  });
  it("IAP allow list is exactly the configured users plus the ops health check", () => {
    const m = ofType(res, "gcp:iap/webCloudRunServiceIamMember:WebCloudRunServiceIamMember").map((x) => String(x.inputs["member"]));
    assert.deepEqual(
      m.filter((x) => x.startsWith("user:")),
      ["user:me@example.com"],
    );
    assert.ok(m.some((x) => x.startsWith("serviceAccount:sa-gha-ops@")));
  });
  it("bot jobs: 6 tasks, no retries, bot-run 14 hours, runtime and discord only where needed", () => {
    const jobs = ofType(res, "gcp:cloudrunv2/job:Job").filter((j) => !["job-db-migration", "job-ml-train"].includes(j.name));
    assert.deepEqual(jobs.map((j) => j.name).sort(), [
      "job-backtest",
      "job-bot-run",
      "job-calendar-check",
      "job-export-dataset",
      "job-reconcile",
      "job-retention",
    ]);
    const inner = (j: Rec): Record<string, unknown> => rec(rec(j.inputs["template"])["template"]);
    for (const j of jobs) assert.equal(inner(j)["maxRetries"], 0);
    const envNames = (n: string): string[] =>
      arr(rec(arr(inner(one(res, "gcp:cloudrunv2/job:Job", n))["containers"])[0])["envs"]).map((e) => String(rec(e)["name"]));
    assert.equal(inner(one(res, "gcp:cloudrunv2/job:Job", "job-bot-run"))["timeout"], "50400s");
    assert.ok(envNames("job-bot-run").includes("BOT_RUN_RESULT_AFTER_MINUTES"));
    assert.ok(envNames("job-bot-run").includes("DISCORD_WEBHOOK_URL"));
    assert.ok(!envNames("job-calendar-check").includes("DISCORD_WEBHOOK_URL"));
    assert.ok(!envNames("job-calendar-check").includes("BOT_RUN_LEASE_SECONDS"));
    assert.ok(
      envNames("job-calendar-check").includes("CALENDAR_WATCH_START_MINUTES") && envNames("job-calendar-check").includes("RUN_JOBS_PREFIX"),
    );
    assert.ok(!envNames("job-reconcile").includes("RUN_JOBS_PREFIX"));
    // backtest は bot-run と同じ判定の設定（BOT_RUN_*）を持ち、通知の宛先（Discord）と起動の権限の設定は持たない
    assert.ok(envNames("job-backtest").includes("BOT_RUN_MAX_ODDS_AGE_SECONDS") && envNames("job-backtest").includes("MODEL_STORE_URI"));
    assert.ok(!envNames("job-backtest").includes("DISCORD_WEBHOOK_URL") && !envNames("job-backtest").includes("RUN_JOBS_PREFIX"));
    const pool = (n: string): unknown =>
      arr(rec(arr(inner(one(res, "gcp:cloudrunv2/job:Job", n))["containers"])[0])["envs"])
        .map(rec)
        .find((e) => e["name"] === "DB_POOL_MAX")?.["value"];
    assert.equal(pool("job-backtest"), "1");
  });
  it("ops deploy updates the image of every bot-image job defined here (no job left on an old image)", () => {
    const src = readFileSync(join(process.cwd(), "ops", "src", "deploy.ts"), "utf8"); // 試験はリポジトリの最上位で実行する（package.json の test）
    const m = /export const BOT_JOBS = \[([^\]]*)\]/.exec(src);
    assert.ok(m?.[1] !== undefined, "BOT_JOBS が読めない");
    const listed = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
    assert.deepEqual(
      listed,
      Object.keys(botJobs(1))
        .map((k) => `jra-bot-${k}`)
        .sort(),
    );
  });
  it("secrets reach containers only by reference (no plain secret values)", () => {
    for (const j of [...ofType(res, "gcp:cloudrunv2/job:Job"), ...ofType(res, "gcp:cloudrunv2/service:Service")]) {
      const t = rec(j.inputs["template"]);
      const c = rec(arr(rec(t["template"] ?? t)["containers"])[0]);
      for (const e of arr(c["envs"]).map(rec)) {
        if (/PASSWORD|WEBHOOK|PEPPER|KEK|SIGNING/.test(String(e["name"]))) {
          assert.equal(e["value"], undefined, String(e["name"]));
          assert.equal(rec(rec(e["valueSource"])["secretKeyRef"])["version"], "latest");
        }
      }
    }
  });
  it("scheduler: paused on create, JST, no retries", () => {
    const s = ofType(res, "gcp:cloudscheduler/job:Job");
    assert.equal(s.length, 3);
    for (const j of s) {
      assert.equal(j.inputs["paused"], true);
      assert.equal(j.inputs["timeZone"], "Asia/Tokyo");
      assert.equal(rec(j.inputs["retryConfig"])["retryCount"], 0);
    }
  });
  it("scheduler URIs, DB URL and env order match Terraform", () => {
    const uri = (n: string): unknown => rec(one(res, "gcp:cloudscheduler/job:Job", n).inputs["httpTarget"])["uri"];
    assert.equal(
      uri("scheduler-calendar-check"),
      "https://run.googleapis.com/v2/projects/proj-1234/locations/asia-northeast1/jobs/jra-bot-calendar-check:run",
    );
    assert.equal(
      uri("scheduler-retention"),
      "https://run.googleapis.com/v2/projects/proj-1234/locations/asia-northeast1/jobs/jra-bot-retention:run",
    );
    const envs = arr(
      rec(arr(rec(one(res, "gcp:cloudrunv2/service:Service", "dashboard").inputs["template"])["containers"])[0])["envs"],
    ).map(rec);
    assert.equal(envs.find((e) => e["name"] === "DB_URL")?.["value"], "jdbc:mysql://10.0.0.3:3306/jrabot?sslMode=VERIFY_CA");
    const plainNames = envs.filter((e) => e["value"] !== undefined).map((e) => String(e["name"]));
    const secretNames = envs.filter((e) => e["value"] === undefined).map((e) => String(e["name"]));
    assert.deepEqual(plainNames, [...plainNames].sort()); // Terraform の dynamic env はキーの順
    assert.deepEqual(secretNames, ["DB_PASSWORD", "INGEST_TOKEN_PEPPER"]);
    assert.ok(envs.findIndex((e) => e["name"] === "DB_PASSWORD") > envs.findIndex((e) => e["name"] === "TZ")); // 平文のブロックの後に Secret のブロック
  });
  it("public grants appear only on the beacon bucket and the ingest service, with fixed targets", () => {
    const pub = res.filter(
      (r) =>
        /(Iam|IAM)(Member|Binding)$/.test(r.type.split(":").pop() ?? "") &&
        ["allUsers", "allAuthenticatedUsers"].includes(String(r.inputs["member"])),
    );
    assert.deepEqual(pub.map((r) => r.name).sort(), ["beacon-public-read", "ingest-public-invoker"]);
    assert.equal(one(res, "gcp:cloudrunv2/serviceIamMember:ServiceIamMember", "ingest-public-invoker").inputs["name"], "jra-bot-ingest");
    assert.equal(one(res, "gcp:storage/bucketIAMMember:BucketIAMMember", "beacon-public-read").inputs["bucket"], "proj-1234-mode-beacon");
  });
  it("values changed by ops and deploy are ignored (Pulumi never flips the running state back)", () => {
    // 期待値は定数ではなくリテラルで書く（定数どうしの比較では、無視の対象を外しても試験が通ってしまう: レビュー 中）
    assert.deepEqual([...IGNORE.sqlInstance], ["settings.activationPolicy"]);
    assert.deepEqual([...IGNORE.service], ["ingress", "client", "clientVersion", "template.containers[0].image", "template.revision"]);
    assert.deepEqual([...IGNORE.botJob], ["client", "clientVersion", "template.template.containers[0].image"]);
    assert.deepEqual(
      [...IGNORE.argJob],
      ["client", "clientVersion", "template.template.containers[0].image", "template.template.containers[0].args"],
    );
    assert.deepEqual([...IGNORE.scheduler], ["paused"]);
    const ig = (type: string, name: string): readonly string[] => {
      const o = opts.find((x) => x.type === type && x.name === name);
      assert.ok(o, `${type} ${name}`);
      return o.ignoreChanges;
    };
    assert.deepEqual(ig("gcp:sql/databaseInstance:DatabaseInstance", "db"), IGNORE.sqlInstance);
    for (const n of ["dashboard", "ingest"]) assert.deepEqual(ig("gcp:cloudrunv2/service:Service", n), IGNORE.service);
    for (const n of ["job-bot-run", "job-calendar-check", "job-reconcile", "job-retention", "job-export-dataset", "job-backtest"])
      assert.deepEqual(ig("gcp:cloudrunv2/job:Job", n), IGNORE.botJob);
    for (const n of ["job-db-migration", "job-ml-train"]) assert.deepEqual(ig("gcp:cloudrunv2/job:Job", n), IGNORE.argJob);
    for (const n of ["scheduler-calendar-check", "scheduler-reconcile", "scheduler-retention"])
      assert.deepEqual(ig("gcp:cloudscheduler/job:Job", n), IGNORE.scheduler);
    assert.ok(IGNORE.sqlInstance.includes("settings.activationPolicy"));
    assert.ok(IGNORE.service.includes("ingress"));
    assert.ok(IGNORE.scheduler.includes("paused"));
  });
  it("db-migration exec is limited to ops and deploy, and only scheduler invokes the scheduled jobs", () => {
    const m = ofType(res, "gcp:cloudrunv2/jobIamMember:JobIamMember");
    const exec = m
      .filter((x) => x.inputs["role"] === "roles/run.jobsExecutorWithOverrides")
      .map((x) => x.name)
      .sort();
    assert.deepEqual(exec, ["bot-launches-bot-run", "db-migration-exec-gha-deploy", "db-migration-exec-gha-ops"]);
    const inv = m.filter((x) => x.inputs["role"] === "roles/run.invoker");
    assert.equal(inv.length, 3);
    for (const x of inv) assert.match(String(x.inputs["member"]), /^serviceAccount:sa-scheduler@/);
  });
});

describe("web image push (web D-276。既定は無効)", () => {
  it("is not created by default (CONTRACTS §1: push の権限は推測しない)", async () => {
    const { res } = await define(BASE);
    assert.equal(parseConfig(BASE).enableWebPush, false);
    assert.equal(res.filter((r) => r.name === "github-web" || r.name === "sa-gha-web-push" || r.name.includes("web-push")).length, 0);
  });
  it("when enabled: a web-only provider for release.yml on main in the release environment, and an SA that can only write to the jra-bot registry", async () => {
    const { res } = await define({ ...BASE, enableWebPush: true });
    const infraProvider = one(res, "gcp:iam/workloadIdentityPoolProvider:WorkloadIdentityPoolProvider", "github");
    assert.equal(
      infraProvider.inputs["attributeCondition"],
      'assertion.repository == "puttun777/jra-bot-infra"',
      "infra の provider は web を拒否したまま",
    );
    const p = one(res, "gcp:iam/workloadIdentityPoolProvider:WorkloadIdentityPoolProvider", "github-web");
    const ref = `puttun777/jra-bot-web/.github/workflows/${WEB_RELEASE_WORKFLOW}@refs/heads/main`;
    assert.equal(
      p.inputs["attributeCondition"],
      `assertion.repository == "puttun777/jra-bot-web" && assertion.workflow_ref == "${ref}" && assertion.ref == "refs/heads/main" && assertion.environment == "release"`,
    );
    assert.deepEqual(p.inputs["attributeMapping"], infraProvider.inputs["attributeMapping"]);
    const bind = one(res, "gcp:serviceaccount/iAMMember:IAMMember", "wif-web-push");
    assert.equal(bind.inputs["role"], "roles/iam.workloadIdentityUser");
    assert.match(
      String(bind.inputs["member"]),
      new RegExp(`/attribute\\.workflow_ref/${ref.replaceAll(".", "\\.").replaceAll("/", "\\/")}$`),
    );
    const writer = one(res, "gcp:artifactregistry/repositoryIamMember:RepositoryIamMember", "registry-writer-gha-web-push");
    assert.equal(writer.inputs["role"], "roles/artifactregistry.writer");
    assert.match(String(writer.inputs["member"]), /^serviceAccount:sa-gha-web-push@/);
    // その SA の権限はこの 1 件と WIF の利用者だけ（プロジェクトの権限・他のリポジトリ・バケット・Secret は無い）
    const grants = res.filter(
      (r) => JSON.stringify(r.inputs).includes("sa-gha-web-push@") && r.type !== "gcp:serviceaccount/account:Account",
    );
    assert.deepEqual(grants.map((g) => g.name).sort(), ["registry-writer-gha-web-push"]);
    const writers = ofType(res, "gcp:artifactregistry/repositoryIamMember:RepositoryIamMember").filter(
      (m) => m.inputs["role"] === "roles/artifactregistry.writer",
    );
    assert.equal(writers.length, 1, "registry に書けるのは web の公開用 SA だけ");
  });
});
