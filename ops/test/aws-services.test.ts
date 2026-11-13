/** EC2 の上のコンテナの定義（docker run の引数）。DB を公開しない・権限の削除・読取り専用・メモリ上限・digest の固定・閲覧用の柵の環境変数。 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertPinned,
  dockerRunArgs,
  FIXED_IPS,
  type HostImages,
  job,
  NETWORK_APP_RANGE,
  NETWORK_NO_IMDS_RANGE,
  services,
} from "../src/aws/services.js";

const D = `@sha256:${"a".repeat(64)}`;
const img: HostImages = {
  dashboard: `123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/jra-bot/dashboard${D}`,
  ingest: `123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/jra-bot/ingest${D}`,
  bot: `123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/jra-bot/bot${D}`,
  dbMigration: `123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/jra-bot/db-migration${D}`,
  mlTrain: `123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/jra-bot/ml-train${D}`,
  mysql: `mysql:8.4.11${D}`,
  caddy: `caddy:2.11.6${D}`,
  oauth2Proxy: `quay.io/oauth2-proxy/oauth2-proxy:v7.15.3${D}`,
};
const s = {
  stateBucket: "jrabot-ops-state",
  modelsBucket: "jrabot-models",
  siteHost: "jrabot.example.com",
  cognitoIssuer: "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_X",
  cognitoClientId: "abc",
};

describe("コンテナの定義", () => {
  it("MySQL はどこにも公開しない。公開は 80/443 と 127.0.0.1 のポートだけ", () => {
    const all = services(img, s);
    const args = dockerRunArgs(all.mysql, { detach: true, remove: false });
    assert.equal(args.includes("--publish"), false);
    assert.deepEqual(all.caddy.ports, ["80:80", "443:443"]);
    for (const n of ["dashboard", "ingest"] as const) for (const p of all[n].ports) assert.match(p, /^127\.0\.0\.1:/);
    assert.throws(() => dockerRunArgs({ ...all.dashboard, ports: ["0.0.0.0:8080:8080"] }, { detach: true, remove: false }), /公開できない/);
    assert.throws(() => dockerRunArgs({ ...all.mysql, ports: ["127.0.0.1:3306:3306"] }, { detach: true, remove: false }), /MySQL/);
  });

  it("すべてのコンテナに no-new-privileges・権限の削除・メモリ上限（スワップなし）・ログの上限。アプリは読取り専用", () => {
    for (const spec of Object.values(services(img, s))) {
      const a = dockerRunArgs(spec, { detach: true, remove: false });
      assert.ok(a.includes("no-new-privileges") && a.includes("--cap-drop"), spec.name);
      assert.equal(a[a.indexOf("--memory") + 1], a[a.indexOf("--memory-swap") + 1]);
      assert.ok(a.includes("max-size=10m"));
      if (spec.name !== "mysql") assert.ok(a.includes("--read-only"), spec.name);
    }
  });

  it("メモリの上限の合計（開催日の最大: 常駐 + bot-run + 1 回の task）が t4g.small（2 GiB）の OS の残りに収まる", () => {
    const mb = (m: string): number => Number(m.replace("m", ""));
    const all = services(img, s);
    const total =
      Object.values(all).reduce((x, c) => x + mb(c.memory), 0) +
      mb(job("bot-run", img, s, "jrabot-botrun", []).memory) +
      mb(job("bot-task", img, s, "x", []).memory);
    assert.ok(total <= 1810, `合計 ${total} MiB`);
  });

  it("bot の Job は閲覧用の柵（OPS_WORKLOAD_GATE=required）と spool の起動を必ず持つ", () => {
    for (const kind of ["bot-run", "bot-task", "batch"] as const) {
      const j = job(kind, img, s, "x", ["--task=bot-run"]);
      assert.equal(j.env["OPS_WORKLOAD_GATE"], "required");
      assert.equal(j.env["JOB_LAUNCHER"], "spool");
      assert.equal(j.env["RUNTIME_PLATFORM"], "aws");
      assert.match(j.env["OPS_MODE_SOURCE"] ?? "", /^s3:\/\//);
    }
    assert.equal(job("ml-train", img, s, "x", []).env["OPS_WORKLOAD_GATE"], "required");
  });

  it("dashboard の前段の oauth2-proxy は Cognito の ID トークンを Authorization で渡し、許可されたメールだけを通す", () => {
    const c = services(img, s)["oauth2-proxy"].command ?? [];
    assert.ok(c.includes("--pass-authorization-header=true"));
    assert.ok(c.includes("--authenticated-emails-file=/run/secrets/allowed-emails"));
    assert.ok(c.includes(`--redirect-url=https://${s.siteHost}/oauth2/callback`));
    assert.ok(c.includes("--cookie-secure=true"));
  });

  it("イメージは digest で固定していなければ動かさない", () => {
    assertPinned(img);
    assert.throws(() => assertPinned({ ...img, caddy: "caddy:2.11.6" }), /digest/);
    assert.throws(() => assertPinned({ ...img, bot: "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/jra-bot/bot:latest" }), /digest/);
  });

  it("インターネットに面する Caddy・oauth2-proxy と MySQL は IMDS に届かない固定 IP、アプリ・ジョブは動的な範囲（固定 IP なし）", () => {
    const all = services(img, s);
    for (const n of ["mysql", "caddy", "oauth2-proxy"] as const) {
      const spec = all[n];
      const args = dockerRunArgs(spec, { detach: true, remove: false });
      assert.equal(args[args.indexOf("--ip") + 1], FIXED_IPS[n]);
      assert.ok(isInNoImdsRange(FIXED_IPS[n]), n);
      const { ip: _ip, ...noIp } = spec;
      assert.throws(() => dockerRunArgs(noIp, { detach: true, remove: false }), /固定 IP/);
      assert.throws(() => dockerRunArgs({ ...spec, ip: "172.30.0.20" }, { detach: true, remove: false }), /固定 IP/);
    }
    for (const spec of [all.dashboard, all.ingest, job("bot-run", img, s, "jrabot-botrun", ["--task=bot-run"])])
      assert.ok(!dockerRunArgs(spec, { detach: true, remove: false }).includes("--ip"), spec.name);
    assert.equal(NETWORK_APP_RANGE, "172.30.0.0/25");
    assert.equal(NETWORK_NO_IMDS_RANGE, "172.30.0.128/25");
  });
});

/** 172.30.0.128/25 に入るか。 */
function isInNoImdsRange(ip: string): boolean {
  const m = /^172\.30\.0\.(\d{1,3})$/.exec(ip);
  return m?.[1] !== undefined && Number(m[1]) >= 128 && Number(m[1]) <= 254;
}
