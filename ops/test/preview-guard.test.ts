/** Pulumi の preview-guard（Terraform の plan-guard と同じ規則。PULUMI_MIGRATION §4）。 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { check as guard } from "../src/preview-guard.js";

const check = (p: unknown, mode: string, allowDestroy = false): string[] => guard(p, mode, allowDestroy, "proj-1234");

const urn = (type: string, name: string): string => `urn:pulumi:prod::jra-bot::${type}::${name}`;
const step = (
  op: string,
  type: string,
  name: string,
  oldInputs?: Record<string, unknown>,
  newInputs?: Record<string, unknown>,
): Record<string, unknown> => ({
  op,
  urn: urn(type, name),
  ...(oldInputs ? { oldState: { type, inputs: oldInputs } } : {}),
  ...(newInputs ? { newState: { type, inputs: newInputs } } : {}),
});
const preview = (...steps: Record<string, unknown>[]): Record<string, unknown> => ({ steps });
const SQL = "gcp:sql/databaseInstance:DatabaseInstance";
const SVC = "gcp:cloudrunv2/service:Service";
const SCH = "gcp:cloudscheduler/job:Job";
const BIM = "gcp:storage/bucketIAMMember:BucketIAMMember";

describe("preview-guard", () => {
  it("no changes is OK in any mode; malformed input is rejected", () => {
    assert.deepEqual(check(preview(), "STARTING"), []);
    assert.deepEqual(check(preview(step("same", SQL, "db")), "UNKNOWN"), []);
    assert.equal(check("x", "NORMAL").length, 1);
    assert.equal(check({ steps: "x" }, "NORMAL").length, 1);
    assert.equal(check(preview({ op: "create" }), "NORMAL").length, 1);
    assert.match(check(preview({ op: "create", urn: "bad" }), "NORMAL")[0] ?? "", /URN/);
    assert.match(check(preview(step("discard", SQL, "db")), "NORMAL")[0] ?? "", /判別できない/);
  });
  it("changes are refused while the mode is transitional", () => {
    const p = check(preview(step("create", "gcp:compute/network:Network", "vpc", undefined, { name: "v" })), "STOPPING");
    assert.ok(p.some((x) => x.includes("mode=STOPPING")));
    assert.deepEqual(check(preview(step("create", "gcp:compute/network:Network", "vpc", undefined, { name: "v" })), "STOPPED"), []);
  });
  it("protected types cannot be deleted or replaced unless explicitly allowed", () => {
    for (const op of ["delete", "replace", "create-replacement", "delete-replaced"]) {
      assert.ok(
        check(preview(step(op, "gcp:storage/bucket:Bucket", "ops-state", { name: "b" }, { name: "b" })), "NORMAL").some((x) =>
          x.includes("削除/置換"),
        ),
        op,
      );
    }
    assert.deepEqual(check(preview(step("delete", "gcp:storage/bucket:Bucket", "ops-state", { name: "b" })), "NORMAL", true), []);
    assert.deepEqual(check(preview(step("delete", "gcp:compute/subnetwork:Subnetwork", "s", { name: "s" })), "NORMAL"), []);
  });
  it("DB users and secret versions are never managed by Pulumi, and no secret values enter the state", () => {
    assert.ok(
      check(preview(step("create", "gcp:sql/user:User", "app", undefined, { name: "app" })), "NORMAL").some((x) =>
        x.includes("管理しない"),
      ),
    );
    assert.ok(check(preview(step("create", "gcp:secretmanager/secretVersion:SecretVersion", "v", undefined, {})), "NORMAL").length > 0);
    const secret = { "4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270", value: "x" };
    assert.ok(
      check(preview(step("update", "gcp:compute/network:Network", "vpc", {}, { description: secret })), "NORMAL").some((x) =>
        x.includes("秘密"),
      ),
    );
  });
  it("running state (activationPolicy, ingress, paused) is only changed by start/stop", () => {
    const sql = (p: string) => ({ settings: { activationPolicy: p } });
    assert.ok(check(preview(step("update", SQL, "db", sql("NEVER"), sql("ALWAYS"))), "NORMAL").some((x) => x.includes("activationPolicy")));
    assert.ok(
      check(
        preview(step("update", SVC, "ingest", { ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY" }, { ingress: "INGRESS_TRAFFIC_ALL" })),
        "NORMAL",
      ).some((x) => x.includes("ingress")),
    );
    assert.ok(
      check(preview(step("update", SCH, "scheduler-reconcile", { paused: true }, { paused: false })), "NORMAL").some((x) =>
        x.includes("paused"),
      ),
    );
    assert.deepEqual(check(preview(step("update", SQL, "db", sql("NEVER"), sql("NEVER"))), "NORMAL"), []);
  });
  it("creation defaults: internal ingress, paused scheduler; IAP cannot be disabled; invoker IAM cannot be dropped", () => {
    assert.ok(
      check(preview(step("create", SVC, "ingest", undefined, { ingress: "INGRESS_TRAFFIC_ALL" })), "NORMAL").some((x) =>
        x.includes("作成時の ingress"),
      ),
    );
    assert.ok(
      check(preview(step("create", SCH, "scheduler-retention", undefined, { paused: false })), "NORMAL").some((x) =>
        x.includes("paused=true"),
      ),
    );
    assert.ok(
      check(preview(step("update", SVC, "dashboard", { iapEnabled: true }, { iapEnabled: false })), "NORMAL").some((x) =>
        x.includes("IAP の無効化"),
      ),
    );
    assert.ok(
      check(preview(step("update", SVC, "dashboard", {}, { invokerIamDisabled: true })), "NORMAL").some((x) =>
        x.includes("invokerIamDisabled"),
      ),
    );
  });
  it("public members only where allowed; unknown members are refused; IAP accessors are users or service accounts", () => {
    const beacon = { bucket: "proj-1234-mode-beacon", role: "roles/storage.objectViewer", member: "allUsers" };
    const invoker = { name: "jra-bot-ingest", role: "roles/run.invoker", member: "allUsers" };
    const SIM = "gcp:cloudrunv2/serviceIamMember:ServiceIamMember";
    assert.deepEqual(check(preview(step("create", BIM, "beacon-public-read", undefined, beacon)), "NORMAL"), []);
    assert.deepEqual(check(preview(step("create", SIM, "ingest-public-invoker", undefined, invoker)), "NORMAL"), []);
    // 許可された論理名でも、向き先・役割が違えば拒否（dashboard を公開にする・モデルのバケットを公開にする）
    assert.ok(
      check(preview(step("create", SIM, "ingest-public-invoker", undefined, { ...invoker, name: "jra-bot-dashboard" })), "NORMAL").length >
        0,
    );
    assert.ok(
      check(preview(step("create", BIM, "beacon-public-read", undefined, { ...beacon, bucket: "proj-1234-model-store" })), "NORMAL")
        .length > 0,
    );
    assert.ok(
      check(preview(step("create", BIM, "beacon-public-read", undefined, { ...beacon, role: "roles/storage.objectAdmin" })), "NORMAL")
        .length > 0,
    );
    assert.ok(
      check(preview(step("create", BIM, "model-store-bot-read", undefined, { member: "allUsers" })), "NORMAL").some((x) =>
        x.includes("allUsers"),
      ),
    );
    assert.ok(check(preview(step("create", BIM, "x", undefined, { member: "allAuthenticatedUsers" })), "NORMAL").length > 0);
    assert.ok(
      check(preview(step("create", BIM, "x", undefined, { member: "04da6b54-80e4-46f7-96ec-b56ff0331ba9" })), "NORMAL").some((x) =>
        x.includes("未確定"),
      ),
    );
    const iap = "gcp:iap/webCloudRunServiceIamMember:WebCloudRunServiceIamMember";
    assert.ok(
      check(preview(step("create", iap, "dashboard-user-x", undefined, { member: "group:all@example.com" })), "NORMAL").some((x) =>
        x.includes("IAP"),
      ),
    );
    assert.deepEqual(check(preview(step("create", iap, "dashboard-user-x", undefined, { member: "user:me@example.com" })), "NORMAL"), []);
  });
  it("replacing the target of an existing public grant is refused (the grant was already public before)", () => {
    const SIM = "gcp:cloudrunv2/serviceIamMember:ServiceIamMember";
    const invoker = { name: "jra-bot-ingest", role: "roles/run.invoker", member: "allUsers" };
    const beacon = { bucket: "proj-1234-mode-beacon", role: "roles/storage.objectViewer", member: "allUsers" };
    assert.ok(
      check(preview(step("replace", SIM, "ingest-public-invoker", invoker, { ...invoker, name: "jra-bot-dashboard" })), "NORMAL").length >
        0,
    );
    assert.ok(
      check(preview(step("replace", BIM, "beacon-public-read", beacon, { ...beacon, bucket: "proj-1234-model-store" })), "NORMAL").length >
        0,
    );
    assert.ok(
      check(preview(step("update", BIM, "beacon-public-read", beacon, { ...beacon, role: "roles/storage.objectAdmin" })), "NORMAL").length >
        0,
    );
    assert.ok(
      check(preview(step("create", BIM, "beacon-public-read", undefined, { ...beacon, bucket: "other-proj-mode-beacon" })), "NORMAL")
        .length > 0,
    ); // 別プロジェクト
    assert.deepEqual(check(preview(step("update", BIM, "beacon-public-read", beacon, beacon)), "NORMAL"), []);
  });
  it("project and service-account IAM are checked too (members, bindings and policies)", () => {
    const PIM = "gcp:projects/iAMMember:IAMMember";
    const SAIM = "gcp:serviceaccount/iAMMember:IAMMember";
    assert.ok(
      check(preview(step("create", PIM, "x", undefined, { role: "roles/owner", member: "allUsers" })), "NORMAL").some((x) =>
        x.includes("allUsers"),
      ),
    );
    assert.ok(
      check(
        preview(step("create", PIM, "x", undefined, { role: "roles/viewer", member: "04da6b54-80e4-46f7-96ec-b56ff0331ba9" })),
        "NORMAL",
      ).some((x) => x.includes("未確定")),
    );
    assert.ok(
      check(
        preview(step("update", SAIM, "wif-deploy", { member: "principalSet://x" }, { member: "allAuthenticatedUsers" })),
        "NORMAL",
      ).some((x) => x.includes("allAuthenticatedUsers")),
    );
    assert.ok(
      check(
        preview(
          step("create", "gcp:projects/iAMBinding:IAMBinding", "b", undefined, { role: "r", members: ["user:a@example.com", "allUsers"] }),
        ),
        "NORMAL",
      ).length > 0,
    );
    const policy = JSON.stringify({ bindings: [{ role: "r", members: ["allAuthenticatedUsers"] }] });
    assert.ok(
      check(preview(step("create", "gcp:projects/iAMPolicy:IAMPolicy", "p", undefined, { policyData: policy })), "NORMAL").length > 0,
    );
    assert.ok(
      check(preview(step("create", "gcp:projects/iAMPolicy:IAMPolicy", "p", undefined, { policyData: "not json" })), "NORMAL").length > 0,
    );
    assert.deepEqual(
      check(
        preview(step("create", PIM, "x", undefined, { role: "roles/viewer", member: "serviceAccount:sa@p.iam.gserviceaccount.com" })),
        "NORMAL",
      ),
      [],
    );
  });
  it("a preview without steps or with error diagnostics is refused", () => {
    assert.equal(check({}, "NORMAL").length, 1);
    assert.equal(check({ steps: [], diagnostics: [{ severity: "error", message: "x" }] }, "NORMAL").length, 1);
    assert.deepEqual(check({ steps: [], diagnostics: [{ severity: "warning", message: "x" }] }, "NORMAL"), []);
  });
  it("DB changes only in NORMAL; provider replacement is refused", () => {
    assert.ok(
      check(
        preview(
          step(
            "update",
            SQL,
            "db",
            { settings: { activationPolicy: "NEVER", tier: "a" } },
            { settings: { activationPolicy: "NEVER", tier: "b" } },
          ),
        ),
        "STOPPED",
      ).some((x) => x.includes("DB に触れる")),
    );
    assert.deepEqual(
      check(
        preview(
          step(
            "update",
            SQL,
            "db",
            { settings: { activationPolicy: "ALWAYS", tier: "a" } },
            { settings: { activationPolicy: "ALWAYS", tier: "b" } },
          ),
        ),
        "NORMAL",
      ),
      [],
    );
    assert.ok(check(preview(step("replace", "pulumi:providers:gcp", "gcp", {}, {})), "NORMAL").some((x) => x.includes("プロバイダ")));
  });
});
