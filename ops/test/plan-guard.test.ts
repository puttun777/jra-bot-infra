/** Terraform の plan-guard（旧 ops/tests/test_plan_guard.py の全ケース）。 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { check, PROTECTED_DESTROY } from "../src/plan-guard.js";

type RC = { address: string; type: string; change: { actions: string[]; before: unknown; after: unknown; after_unknown?: unknown } };
const rc = (typ: string, actions: string[], before: unknown = null, after: unknown = null, addr?: string): RC => ({
  address: addr ?? `${typ}.x`,
  type: typ,
  change: { actions, before, after },
});
const plan = (...rcs: RC[]) => ({ resource_changes: rcs });

describe("plan guard", () => {
  it("no-op and ordinary update pass", () => {
    const p = plan(
      rc("google_cloud_run_v2_service", ["no-op"]),
      rc("google_cloud_run_v2_service", ["update"], { ingress: "internal", x: 1 }, { ingress: "internal", x: 2 }),
    );
    assert.deepEqual(check(p, "STOPPED"), []);
  });
  it("activation policy change is rejected", () => {
    const out = check(
      plan(
        rc(
          "google_sql_database_instance",
          ["update"],
          { settings: [{ activation_policy: "NEVER" }] },
          { settings: [{ activation_policy: "ALWAYS" }] },
        ),
      ),
      "NORMAL",
    );
    assert.ok(
      out.some((m) => m.includes("activation_policy")),
      out.join(),
    );
  });
  it("ingress and paused changes are rejected", () => {
    assert.ok(
      check(plan(rc("google_cloud_run_v2_service", ["update"], { ingress: "internal" }, { ingress: "all" })), "STOPPED").some((m) =>
        m.includes("ingress"),
      ),
    );
    assert.ok(
      check(plan(rc("google_cloud_scheduler_job", ["update"], { paused: true }, { paused: false })), "STOPPED").some((m) =>
        m.includes("paused"),
      ),
    );
  });
  it("delete or replace of protected resources is rejected unless allowed", () => {
    for (const t of PROTECTED_DESTROY) {
      const p = plan(rc(t, ["delete", "create"], { a: 1 }, { a: 1 }));
      assert.ok(check(p, "NORMAL").length > 0, t);
      assert.deepEqual(
        check(p, "NORMAL", true).filter((m) => m.includes("削除")),
        [],
        t,
      );
    }
  });
  it("public grants are rejected except the two designed ones", () => {
    assert.ok(
      check(
        plan(
          rc(
            "google_cloud_run_v2_service_iam_member",
            ["create"],
            null,
            { member: "allUsers", name: "jra-bot-dashboard" },
            "google_cloud_run_v2_service_iam_member.dash",
          ),
        ),
        "NORMAL",
      ).length > 0,
    );
    assert.deepEqual(
      check(
        plan(
          rc(
            "google_cloud_run_v2_service_iam_member",
            ["create"],
            null,
            { member: "allUsers", name: "jra-bot-ingest" },
            "google_cloud_run_v2_service_iam_member.jra-bot-ingest",
          ),
        ),
        "NORMAL",
      ),
      [],
    );
    assert.ok(
      check(
        plan(
          rc(
            "google_storage_bucket_iam_member",
            ["create"],
            null,
            { member: "allAuthenticatedUsers" },
            "google_storage_bucket_iam_member.data",
          ),
        ),
        "NORMAL",
      ).length > 0,
    );
  });
  it("iap disable is rejected", () => {
    assert.ok(
      check(
        plan(rc("google_cloud_run_v2_service", ["update"], { iap_enabled: true, ingress: "all" }, { iap_enabled: false, ingress: "all" })),
        "NORMAL",
      ).some((m) => m.includes("IAP")),
    );
  });
  it("db changes only in NORMAL", () => {
    const p = plan(rc("google_sql_user", ["update"], { a: 1 }, { a: 2 }));
    assert.ok(check(p, "STOPPED").length > 0);
    assert.ok(check(p, "STARTING").length > 0);
    assert.deepEqual(check(p, "NORMAL"), []);
  });
  it("no apply while STARTING, STOPPING or UNKNOWN", () => {
    const p = plan(rc("google_cloud_run_v2_service", ["update"], { ingress: "internal", x: 1 }, { ingress: "internal", x: 2 }));
    for (const m of ["STARTING", "STOPPING", "UNKNOWN"]) assert.ok(check(p, m).length > 0, m);
    assert.deepEqual(check(plan(rc("google_cloud_run_v2_service", ["no-op"])), "STARTING"), []);
  });
  it("iam policy with a public member is rejected", () => {
    const pol = '{"bindings":[{"role":"roles/run.invoker","members":["allUsers"]}]}';
    assert.ok(
      check(
        plan(
          rc(
            "google_cloud_run_v2_service_iam_policy",
            ["create"],
            null,
            { policy_data: pol },
            "google_cloud_run_v2_service_iam_policy.dash",
          ),
        ),
        "NORMAL",
      ).length > 0,
    );
  });
  it("iap accessor only users and service accounts", () => {
    const t = "google_iap_web_cloud_run_service_iam_member";
    assert.deepEqual(check(plan(rc(t, ["create"], null, { member: "user:a@example.com" })), "NORMAL"), []);
    assert.deepEqual(check(plan(rc(t, ["create"], null, { member: "serviceAccount:x@p.iam.gserviceaccount.com" })), "NORMAL"), []);
    for (const bad of ["domain:example.com", "group:g@example.com", "allUsers"])
      assert.ok(check(plan(rc(t, ["create"], null, { member: bad })), "NORMAL").length > 0, bad);
  });
  it("unknown iam member is rejected", () => {
    const r = rc(
      "google_cloud_run_v2_service_iam_member",
      ["create"],
      null,
      { role: "roles/run.invoker" },
      "google_cloud_run_v2_service_iam_member.x",
    );
    r.change.after_unknown = { member: true };
    assert.ok(check(plan(r), "NORMAL").some((m) => m.includes("未確定")));
  });
  it("create-time ingress, paused and invoker iam", () => {
    assert.ok(check(plan(rc("google_cloud_run_v2_service", ["create"], null, { ingress: "INGRESS_TRAFFIC_ALL" })), "NORMAL").length > 0);
    assert.deepEqual(
      check(plan(rc("google_cloud_run_v2_service", ["create"], null, { ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY" })), "NORMAL"),
      [],
    );
    assert.ok(check(plan(rc("google_cloud_scheduler_job", ["create"], null, { paused: false })), "NORMAL").length > 0);
    assert.ok(
      check(plan(rc("google_cloud_run_v2_service", ["update"], { invoker_iam_disabled: false }, { invoker_iam_disabled: true })), "NORMAL")
        .length > 0,
    );
  });
  it("malformed plans and missing actions fail closed", () => {
    assert.ok(check([], "NORMAL").length > 0);
    assert.ok(check({ resource_changes: "x" }, "NORMAL").length > 0);
    assert.ok(check({ resource_changes: [{ address: "a", type: "google_sql_user", change: {} }] }, "STOPPED").length > 0);
  });
});
