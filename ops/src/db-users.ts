/**
 * DB ユーザーの作成とパスワードの設定（`ops db-users`。docs/PULUMI_MIGRATION.md §3）。
 * Terraform は write-only 引数（password_wo）で DB ユーザーを作っていたが、Pulumi は入力値を state に記録しないことを確認できないため、
 * Pulumi では作らず、この明示操作で作る。パスワードは Secret Manager の最新版を読み、SQL Admin API の要求の本文（HTTPS）にだけ載せる
 * （コマンドラインの引数・標準出力・ログ・state に出さない）。パスワードの無いユーザーは作らない（作成と設定は 1 回の users.insert）。
 * **実 GCP では未検証**。実行は本人（初回の導入: OPERATIONS.md。DB が起動している NORMAL のときだけ）。
 */
import { z } from "zod";
import type { Fetch } from "./gcp/gcs.js";

/** DB ユーザー → パスワードの Secret（web CONTRACTS §8.2。Terraform の locals.db_users と同じ）。 */
export const DB_USERS: Readonly<Record<string, string>> = {
  migrate: "db-migrate-password",
  app: "db-app-password",
  ingest: "db-ingest-password",
  bot: "db-bot-password",
  mltrain: "db-mltrain-password",
};
export const INSTANCE = "jra-bot-db";
const MIN_PASSWORD = 20;

export class DbUsersError extends Error {}

/** JSON として読む。失敗しても入力の断片を例外に載せない（Secret の応答を扱うため）。 */
function parseQuiet(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new DbUsersError(`${what} の応答が JSON として読めない`);
  }
}

const SecretAccess = z.looseObject({ payload: z.looseObject({ data: z.string() }) });
const UsersList = z.looseObject({ items: z.array(z.looseObject({ name: z.string(), host: z.string().optional() })).optional() });

export interface DbUsersResult {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly unchanged: readonly string[];
}

/**
 * 足りない DB ユーザーを作る。`rotate` のときは既存のユーザーのパスワードも Secret の最新版に合わせる（それ以外は既存を変えない）。
 * 失敗は理由だけ（値は出さない）。途中で失敗したら、それまでの変更は残る（再実行で続きから。冪等）。
 */
export async function ensureDbUsers(opts: {
  readonly project: string;
  readonly mode: string;
  readonly rotate: boolean;
  readonly fetchFn: Fetch;
  readonly token: () => Promise<string>;
  readonly instance?: string;
}): Promise<DbUsersResult> {
  if (opts.mode !== "NORMAL")
    throw new DbUsersError(`mode=${opts.mode} の間は DB ユーザーを変更しない（DB が起動している NORMAL のときだけ）`);
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(opts.project)) throw new DbUsersError("--project の形式が不正");
  const instance = opts.instance ?? INSTANCE;
  const sql = `https://sqladmin.googleapis.com/v1/projects/${opts.project}/instances/${instance}/users`;
  const call = async (method: string, url: string, body?: unknown): Promise<string> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${await opts.token()}` };
    const init: { method: string; headers: Record<string, string>; body?: Buffer; signal?: AbortSignal } = {
      method,
      headers,
      signal: AbortSignal.timeout(30_000),
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = Buffer.from(JSON.stringify(body), "utf8");
    }
    const r = await opts.fetchFn(url, init);
    const text = await r.text();
    // 応答の本文は出さない（エラーの本文に値が含まれ得る）。状態コードと操作だけ
    if (r.status < 200 || r.status >= 300) throw new DbUsersError(`${method} ${url.replace(/\?.*$/, "")} が HTTP ${r.status}`);
    return text;
  };
  const listed = UsersList.safeParse(parseQuiet(await call("GET", sql), "users.list"));
  if (!listed.success) throw new DbUsersError("users.list の応答の形式が想定と違う");
  const existing = new Set((listed.data.items ?? []).filter((u) => (u.host ?? "%") === "%").map((u) => u.name));
  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  for (const [user, secret] of Object.entries(DB_USERS)) {
    const has = existing.has(user);
    if (has && !opts.rotate) {
      unchanged.push(user);
      continue;
    }
    const acc = SecretAccess.safeParse(
      parseQuiet(
        await call("GET", `https://secretmanager.googleapis.com/v1/projects/${opts.project}/secrets/${secret}/versions/latest:access`),
        secret,
      ),
    );
    if (!acc.success) throw new DbUsersError(`${secret} の応答の形式が想定と違う`);
    const password = Buffer.from(acc.data.payload.data, "base64").toString("utf8");
    if (password.length < MIN_PASSWORD || /[\r\n]/.test(password))
      throw new DbUsersError(`${secret} の値が短い、または改行を含む（${MIN_PASSWORD} 文字以上の 1 行）`);
    if (has) {
      await call("PUT", `${sql}?name=${encodeURIComponent(user)}&host=${encodeURIComponent("%")}`, { name: user, host: "%", password });
      updated.push(user);
    } else {
      await call("POST", sql, { name: user, host: "%", password });
      created.push(user);
    }
  }
  return { created, updated, unchanged };
}
