/** ops db-users（Pulumi が作らない DB ユーザーの作成。PULUMI_MIGRATION §3）。偽の fetch で SQL Admin・Secret Manager の要求を検査する。 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DB_USERS, DbUsersError, ensureDbUsers } from "../src/db-users.js";
import type { Fetch } from "../src/gcp/gcs.js";

interface Call {
  method: string;
  url: string;
  body: string | undefined;
  auth: string | undefined;
}

const PW = (u: string): string => `pw-${u}-0123456789abcdefghij`;

function fake(
  existing: string[],
  opts: { failOn?: string; secret?: (s: string) => string; opError?: boolean } = {},
): { fetchFn: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: Fetch = async (url, init) => {
    calls.push({ method: init.method, url, body: init.body?.toString("utf8"), auth: init.headers["Authorization"] });
    const res = (status: number, body: unknown) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
    if (opts.failOn !== undefined && url.includes(opts.failOn)) return res(403, { error: { message: "SECRET-IN-ERROR-BODY" } });
    if (url.includes("secretmanager")) {
      const m = /secrets\/([^/]+)\/versions/.exec(url);
      const name = m?.[1] ?? "";
      const user = Object.entries(DB_USERS).find(([, s]) => s === name)?.[0] ?? "";
      const value = opts.secret ? opts.secret(name) : PW(user);
      return res(200, { payload: { data: Buffer.from(value).toString("base64") } });
    }
    if (url.includes("/operations/"))
      return res(200, {
        name: "op-1",
        status: "DONE",
        ...(opts.opError ? { error: { errors: [{ code: "X", message: "SECRET-IN-OP" }] } } : {}),
      });
    if (init.method === "GET") return res(200, { items: existing.map((name) => ({ name, host: "%" })) });
    return res(200, { kind: "sql#operation", name: "op-1", status: "PENDING" });
  };
  return { fetchFn, calls };
}

const run = (f: Fetch, mode = "NORMAL", rotate = false) =>
  ensureDbUsers({ project: "proj-1234", mode, rotate, fetchFn: f, token: async () => "tok", sleep: async () => {}, pollIntervalMs: 0 });

describe("db-users", () => {
  it("creates only missing users, with the password from Secret Manager in the request body only", async () => {
    const { fetchFn, calls } = fake(["app", "bot"]);
    const r = await run(fetchFn);
    assert.deepEqual([...r.created].sort(), ["ingest", "migrate", "mltrain"]);
    assert.deepEqual([...r.unchanged].sort(), ["app", "bot"]);
    const posts = calls.filter((c) => c.method === "POST");
    assert.equal(posts.length, 3);
    for (const p of posts) {
      const b = JSON.parse(p.body ?? "{}") as { name: string; host: string; password: string };
      assert.equal(b.host, "%");
      assert.equal(b.password, PW(b.name));
      assert.equal(p.url, "https://sqladmin.googleapis.com/v1/projects/proj-1234/instances/jra-bot-db/users");
      assert.ok(!p.url.includes(b.password)); // URL には載せない
    }
    assert.ok(calls.every((c) => c.auth === "Bearer tok"));
    assert.equal(calls.filter((c) => c.url.includes("secretmanager")).length, 3); // 既存のユーザーの Secret は読まない
  });
  it("rotate updates existing users with PUT", async () => {
    const { fetchFn, calls } = fake(Object.keys(DB_USERS));
    const r = await run(fetchFn, "NORMAL", true);
    assert.equal(r.updated.length, 5);
    assert.ok(calls.filter((c) => c.method === "PUT").every((c) => c.url.includes("?name=") && c.url.includes("&host=%25")));
  });
  it("refuses outside NORMAL, before touching anything", async () => {
    const { fetchFn, calls } = fake([]);
    await assert.rejects(run(fetchFn, "STOPPED"), DbUsersError);
    assert.equal(calls.length, 0);
  });
  it("refuses short or multi-line secrets and never echoes values or error bodies", async () => {
    const short = fake([], { secret: () => "short" });
    await assert.rejects(run(short.fetchFn), (e: unknown) => e instanceof DbUsersError && !e.message.includes("short"));
    assert.equal(short.calls.filter((c) => c.method === "POST").length, 0); // パスワードの無い/弱いユーザーを作らない
    const nl = fake([], { secret: () => "a".repeat(30) + "\n" });
    await assert.rejects(run(nl.fetchFn), DbUsersError);
    const denied = fake([], { failOn: "secretmanager" });
    await assert.rejects(
      run(denied.fetchFn),
      (e: unknown) => e instanceof DbUsersError && !e.message.includes("SECRET-IN-ERROR-BODY") && e.message.includes("403"),
    );
  });
  it("rejects malformed responses and project ids (fail closed)", async () => {
    const bad: Fetch = async () => ({ status: 200, headers: { get: () => null }, text: async () => "[]" });
    await assert.rejects(run(bad), DbUsersError);
    await assert.rejects(
      ensureDbUsers({ project: "Bad/Project", mode: "NORMAL", rotate: false, fetchFn: bad, token: async () => "t" }),
      DbUsersError,
    );
  });
  it("waits for each asynchronous SQL Admin operation and fails on an operation error without echoing it", async () => {
    const ok = fake([]);
    await run(ok.fetchFn);
    const seq = ok.calls.filter((c) => !c.url.includes("secretmanager")).map((c) => (c.url.includes("/operations/") ? "WAIT" : c.method));
    assert.deepEqual(seq, ["GET", "POST", "WAIT", "POST", "WAIT", "POST", "WAIT", "POST", "WAIT", "POST", "WAIT"]); // 1 件ずつ完了を待ってから次へ
    const failed = fake([], { opError: true });
    await assert.rejects(
      run(failed.fetchFn),
      (e: unknown) => e instanceof DbUsersError && e.message.includes("失敗") && !e.message.includes("SECRET-IN-OP"),
    );
    assert.equal(failed.calls.filter((c) => c.method === "POST").length, 1); // 失敗したら先へ進まない
  });
  it("gives up on an operation that never finishes", async () => {
    const stuck: Fetch = async (url, init) => {
      const res = (body: unknown) => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });
      if (url.includes("secretmanager")) return res({ payload: { data: Buffer.from("x".repeat(30)).toString("base64") } });
      if (init.method === "GET" && !url.includes("/operations/")) return res({ items: [] });
      return res({ name: "op-1", status: "RUNNING" });
    };
    await assert.rejects(
      ensureDbUsers({
        project: "proj-1234",
        mode: "NORMAL",
        rotate: false,
        fetchFn: stuck,
        token: async () => "t",
        sleep: async () => {},
        maxPolls: 3,
      }),
      /終わらない/,
    );
  });
});
