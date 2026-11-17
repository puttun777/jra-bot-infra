// CloudFront の後ろのリバースプロキシ（pulumi-aws/host/Caddyfile）の結合試験。実物の Caddy（digest で固定したイメージ）を、上流を
// 「受け取った要求を返すだけ」の Caddy に置き換えて動かし、CloudFront からの要求を模した HTTP で確かめる（実 CloudFront・実 AWS ではない）。
// 確かめること: 合言葉（X-Origin-Verify）が無い・違う要求の拒否、Host の検査、識別ヘッダの除去、上流へ https と公開ホストを伝える、
// /internal の 404、/_jrabot/health、/logout、エージェントの経路（メソッド・クエリ・本文・署名のヘッダをそのまま）、既定の no-store。
//   node ops/it/caddy-edge.mjs            （CADDY_IMAGE で上書き可）
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IMAGE = process.env.CADDY_IMAGE ?? "caddy:2.11.6@sha256:3422ce6de165df66534f9b9ba50efaf457114ec961763cc52f5dbdaac2972d73";
const SITE = "d1234567890abc.cloudfront.net";
const SECRET = randomBytes(24).toString("hex");
const LOGOUT = encodeURIComponent(
  `https://owner-auth.auth.ap-northeast-1.amazoncognito.com/logout?client_id=abc123&logout_uri=${encodeURIComponent(`https://${SITE}/`)}`,
);
const id = randomBytes(3).toString("hex");
const net = `jrabot-edge-it-${id}`;
const edge = `jrabot-edge-${id}`;
const echo = `jrabot-echo-${id}`;
const work = mkdtempSync(join(tmpdir(), "jrabot-edge-"));

const docker = (args, input) => {
  const r = spawnSync("docker", args, { encoding: "utf8", input });
  if (r.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(" ")} が失敗: ${(r.stderr ?? "").slice(-400)}`);
  return r.stdout.trim();
};
const send = (port, { method = "GET", path = "/", headers = {}, body }) =>
  new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers, timeout: 10_000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (body !== undefined) req.write(body);
    req.end();
  });

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) failures++;
};

try {
  // 上流の代わり: 受け取った要求の要点を返す（ingest = 8080、oauth2-proxy = 4180）
  const echoConf = (who) => `:${who === "ingest" ? 8080 : 4180} {
	respond "who=${who} method={method} uri={uri} host={host} xfp={header.X-Forwarded-Proto} xfh={header.X-Forwarded-Host} verify=[{header.X-Origin-Verify}] user=[{header.X-Forwarded-User}] iap=[{header.X-Goog-Iap-Jwt-Assertion}] email=[{header.X-Auth-Request-Email}] auth=[{header.Authorization}] cookie=[{header.Cookie}] sig=[{header.X-Signature}] agent=[{header.X-Agent-Id}]" 200
}
`;
  writeFileSync(join(work, "Echo"), `{\n\tadmin off\n\tauto_https off\n}\n${echoConf("ingest")}${echoConf("oauth2")}`);
  writeFileSync(
    join(work, "Caddyfile"),
    readFileSync(process.env.CADDYFILE ?? new URL("../../pulumi-aws/host/Caddyfile", import.meta.url)),
  );
  docker(["network", "create", net]);
  docker([
    "run",
    "-d",
    "--name",
    echo,
    "--network",
    net,
    "--network-alias",
    "jrabot-ingest",
    "--network-alias",
    "jrabot-oauth2-proxy",
    "-v",
    `${work}/Echo:/etc/caddy/Caddyfile:ro`,
    IMAGE,
  ]);
  // services.ts と同じ制限（読取り専用・権限の削除・80 番だけ）
  docker([
    "run",
    "-d",
    "--name",
    edge,
    "--network",
    net,
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/config",
    "--tmpfs",
    "/data",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "NET_BIND_SERVICE",
    "--security-opt",
    "no-new-privileges",
    "-e",
    `SITE_HOST=${SITE}`,
    "-e",
    `ORIGIN_VERIFY=${SECRET}`,
    "-e",
    `LOGOUT_TARGET=${LOGOUT}`,
    "-p",
    "127.0.0.1::80",
    "-v",
    `${work}/Caddyfile:/etc/caddy/Caddyfile:ro`,
    IMAGE,
  ]);
  const port = Number(docker(["port", edge, "80/tcp"]).split("\n")[0]?.split(":").at(-1));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      await send(port, { path: "/_jrabot/health", headers: { Host: SITE, "X-Origin-Verify": SECRET } });
      up = true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!up) throw new Error(`Caddy が起動しない: ${spawnSync("docker", ["logs", edge], { encoding: "utf8" }).stderr.slice(-800)}`);
  const via = { Host: SITE, "X-Origin-Verify": SECRET };

  // 直接の接続・別の経路（合言葉が無い・違う）は 403、Host が違えば 421
  check("合言葉が無い要求は 403", (await send(port, { headers: { Host: SITE } })).status === 403);
  check("合言葉が違う要求は 403", (await send(port, { headers: { Host: SITE, "X-Origin-Verify": `${SECRET}x` } })).status === 403);
  check(
    "合言葉の前方一致では通らない",
    (await send(port, { headers: { Host: SITE, "X-Origin-Verify": SECRET.slice(0, 10) } })).status === 403,
  );
  check(
    "合言葉が無ければ /v1/agent・/_jrabot/health も 403",
    (await send(port, { path: "/v1/agent/mode", headers: { Host: SITE } })).status === 403 &&
      (await send(port, { path: "/_jrabot/health", headers: { Host: SITE } })).status === 403,
  );
  check(
    "Host が公開 URL でなければ 421",
    (await send(port, { headers: { ...via, Host: "ec2-1-2-3-4.compute.amazonaws.com" } })).status === 421,
  );

  // 画面（oauth2-proxy へ）: https・公開ホストを伝え、合言葉・識別のヘッダは渡さない。Cookie と Authorization はそのまま（oauth2-proxy が判断）
  const r = await send(port, {
    path: "/api/v1/me?x=1",
    headers: {
      ...via,
      "X-Forwarded-User": "attacker@example.com",
      "X-Auth-Request-Email": "attacker@example.com",
      "X-Goog-IAP-JWT-Assertion": "eyJhbGciOiJub25lIn0.e30.",
      "X-Forwarded-Proto": "http",
      Cookie: "__Host-jrabot=abc",
    },
  });
  check("画面は oauth2-proxy へ", r.status === 200 && r.body.includes("who=oauth2"), r.body);
  check(
    "上流には X-Forwarded-Proto: https と公開ホスト（クライアントの値で上書きさせない）",
    r.body.includes("xfp=https") && r.body.includes(`xfh=${SITE}`) && r.body.includes(`host=${SITE}`),
    r.body,
  );
  check("合言葉は上流へ渡さない", r.body.includes("verify=[]"), r.body);
  check(
    "クライアントが付けた利用者・IAP の識別ヘッダは捨てる",
    r.body.includes("user=[]") && r.body.includes("iap=[]") && r.body.includes("email=[]"),
    r.body,
  );
  check("Cookie とクエリはそのまま", r.body.includes("cookie=[__Host-jrabot=abc]") && r.body.includes("uri=/api/v1/me?x=1"), r.body);
  check(
    "既定は Cache-Control: no-store・HSTS あり・Server なし",
    r.headers["cache-control"] === "no-store" &&
      /max-age=31536000/.test(String(r.headers["strict-transport-security"])) &&
      r.headers["server"] === undefined,
    JSON.stringify(r.headers),
  );

  // 管理操作の POST も同じ経路（CSRF の Origin/Host は oauth2-proxy・dashboard が検査）
  const post = await send(port, {
    method: "POST",
    path: "/api/v1/admin/agents",
    headers: { ...via, "Content-Type": "application/json", Origin: `https://${SITE}` },
    body: "{}",
  });
  check("POST も oauth2-proxy へ（メソッドを変えない）", post.status === 200 && post.body.includes("who=oauth2 method=POST"), post.body);

  // エージェント: ingest へ直接（人のログインを通さない）。メソッド・クエリ・署名のヘッダ・本文をそのまま
  const a = await send(port, {
    method: "POST",
    path: "/v1/agent/ingest?batch=1",
    headers: {
      ...via,
      "X-Agent-Id": "ag_main",
      "X-Signature": "a".repeat(64),
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
    },
    body: "x",
  });
  check(
    "エージェントは ingest へ（oauth2-proxy を通さない）",
    a.body.includes("who=ingest") && a.body.includes("method=POST") && a.body.includes("uri=/v1/agent/ingest?batch=1"),
    a.body,
  );
  check("エージェントの署名のヘッダはそのまま", a.body.includes(`sig=[${"a".repeat(64)}]`) && a.body.includes("agent=[ag_main]"), a.body);

  check("/internal は 404", (await send(port, { path: "/internal/health", headers: via })).status === 404);
  check("/internal/ops/mode も 404", (await send(port, { path: "/internal/ops/mode", headers: via })).status === 404);
  const h = await send(port, { path: "/_jrabot/health", headers: via });
  check(
    "/_jrabot/health は 200 ok・no-store",
    h.status === 200 && h.body === "ok" && h.headers["cache-control"] === "no-store",
    JSON.stringify([h.status, h.body]),
  );
  const lo = await send(port, { path: "/logout", headers: via });
  check(
    "/logout は oauth2-proxy の sign_out → Cognito のログアウトへ",
    lo.status === 302 && lo.headers.location === `/oauth2/sign_out?rd=${LOGOUT}`,
    String(lo.headers.location),
  );
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  failures++;
} finally {
  for (const c of [edge, echo]) spawnSync("docker", ["rm", "-f", c], { encoding: "utf8" });
  spawnSync("docker", ["network", "rm", net], { encoding: "utf8" });
  rmSync(work, { recursive: true, force: true });
}
console.log(`caddy-edge: ${failures === 0 ? "OK" : `NG（${failures} 件）`}`);
process.exit(failures === 0 ? 0 : 1);
