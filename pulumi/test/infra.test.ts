// Pulumi の定義の mock 試験（GCP 認証なし。資源は作らない）。Terraform の試験（terraform/tests/base・deploy.tftest.hcl）と同じ性質を検査する。
// **mock の成功は実 GCP の preview の成功ではない**（docs/PULUMI_MIGRATION.md §5）。
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import * as pulumi from "@pulumi/pulumi";
import { parseConfig, REQUIRED_RUNTIME_KEYS } from "../src/config.js";
import { DEPLOYER_PERMISSIONS, defineInfra, IGNORE, OPS_CONTROLLER_PERMISSIONS, SECRETS, TF_ROLES, WIF_WORKFLOWS } from "../src/infra.js";

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

async function settle(): Promise<void> {
  let last = -1;
  for (let i = 0; i < 200 && created.length !== last; i++) {
    last = created.length;
    await new Promise((r) => setTimeout(r, 10));
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
  it("bot jobs: 5 tasks, no retries, bot-run 14 hours, runtime and discord only where needed", () => {
    const jobs = ofType(res, "gcp:cloudrunv2/job:Job").filter((j) => !["job-db-migration", "job-ml-train"].includes(j.name));
    assert.deepEqual(jobs.map((j) => j.name).sort(), [
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
  it("values changed by ops and deploy are ignored (Pulumi never flips the running state back)", () => {
    const ig = (type: string, name: string): readonly string[] => {
      const o = opts.find((x) => x.type === type && x.name === name);
      assert.ok(o, `${type} ${name}`);
      return o.ignoreChanges;
    };
    assert.deepEqual(ig("gcp:sql/databaseInstance:DatabaseInstance", "db"), IGNORE.sqlInstance);
    for (const n of ["dashboard", "ingest"]) assert.deepEqual(ig("gcp:cloudrunv2/service:Service", n), IGNORE.service);
    for (const n of ["job-bot-run", "job-calendar-check", "job-reconcile", "job-retention", "job-export-dataset"])
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
