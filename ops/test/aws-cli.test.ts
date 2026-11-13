/** ops aws の CLI の純粋な部分: deploy の版（manifest + host_images）の組立てと、状態の表示。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildRelease, CliError, parseHostImages, render } from "../src/aws/cli.js";

const D = `@sha256:${"b".repeat(64)}`;
const ECR = "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/jra-bot";
const H = "b".repeat(64);
const SCHEMA: unknown = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "..", "schemas", "release-manifest.v3.json"), "utf8"),
);
const manifest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema_version: 3,
  release: "2026.11.3",
  git_sha: "c".repeat(40),
  built_at: "2026-11-13T00:00:00Z",
  contract_version: "0.4.19",
  agent_protocol: 1,
  images: Object.fromEntries(["dashboard", "ingest", "bot", "db-migration", "ml-train"].map((n) => [n, `${ECR}/${n}${D}`])),
  flyway: { latest_version: "5", baseline: "1" },
  required_schema_version: "5",
  rollback: { min_app_release: "2026.11.0" },
  model_schema_versions: [1],
  feature_schemas: { calibration: `sha256:${H}`, alpha: `sha256:${H}`, market: `sha256:${H}` },
  feature_schema_hash: `sha256:${H}`,
  runtime: { jdk: "25", arch: "arm64" },
  notes: "test",
  ...over,
});
const hostImages = JSON.stringify({
  mysql: `mysql:8.4.11${D}`,
  caddy: `caddy:2.11.6${D}`,
  "oauth2-proxy": `quay.io/oauth2-proxy/oauth2-proxy:v7.15.3${D}`,
});

describe("deploy の版", () => {
  it("manifest に host_images を足す（ホストが読む control/release-candidate.json）", () => {
    const r = buildRelease(manifest(), SCHEMA, parseHostImages(hostImages), "arm64");
    assert.equal(r.release, "2026.11.3");
    assert.equal(r.host_images["oauth2-proxy"], `quay.io/oauth2-proxy/oauth2-proxy:v7.15.3${D}`);
    assert.equal(r.images["bot"], `${ECR}/bot${D}`);
  });

  it("CPU の不一致・arch の無い manifest・GCP のイメージ・足りないイメージは拒否", () => {
    assert.throws(() => buildRelease(manifest(), SCHEMA, parseHostImages(hostImages), "amd64"), CliError);
    assert.throws(() => buildRelease(manifest({ runtime: { jdk: "25" } }), SCHEMA, parseHostImages(hostImages), "arm64"), /runtime\.arch/);
    assert.throws(
      () => buildRelease(manifest({ contract_version: "0.5.0" }), SCHEMA, parseHostImages(hostImages), "arm64"),
      /contract_version/,
    );
    const gcp = manifest({
      images: { dashboard: `asia-northeast1-docker.pkg.dev/p/jra-bot/dashboard${D}` },
    });
    assert.throws(() => buildRelease(gcp, SCHEMA, parseHostImages(hostImages), "arm64"), /スキーマに合わない|AWS 向けではない/);
    const { "ml-train": _drop, ...partial } = manifest()["images"] as Record<string, string>;
    assert.throws(() => buildRelease(manifest({ images: partial }), SCHEMA, parseHostImages(hostImages), "arm64"), /スキーマに合わない/);
    const gcpAll = manifest({
      images: Object.fromEntries(
        ["dashboard", "ingest", "bot", "db-migration", "ml-train"].map((n) => [
          n,
          `asia-northeast1-docker.pkg.dev/jra-bot-prod-1/jra-bot/${n}${D}`,
        ]),
      ),
    });
    assert.throws(
      () => buildRelease(gcpAll, SCHEMA, parseHostImages(hostImages), "arm64"),
      /AWS 向けではない/,
      "GCP のイメージは AWS に入れない",
    );
  });

  it("HOST_IMAGES は tag と digest の両方で固定し、余計なキー・別のレジストリを拒否", () => {
    const bad = (o: Record<string, string>): void => {
      assert.throws(() => parseHostImages(JSON.stringify(o)), CliError);
    };
    const ok = JSON.parse(hostImages) as Record<string, string>;
    bad({ ...ok, mysql: "mysql:8.4.11" });
    bad({ ...ok, "oauth2-proxy": "quay.io/oauth2-proxy/oauth2-proxy:v7.15.3" });
    bad({ ...ok, caddy: `evil.example.com/caddy:2${D}` });
    bad({ ...ok, extra: `mysql:8${D}` });
    assert.throws(() => parseHostImages("not json"), /JSON/);
  });
});

describe("状態の表示", () => {
  it("準備完了まで接続先を出さない・hold と自動停止の予定を出す", () => {
    const text = render({
      ok: true,
      message: "閲覧の起動を受け付けた",
      summary: {
        mode: "STARTING",
        ec2: "pending",
        usable: false,
        url: null,
        holds: [{ id: "h1", purpose: "VIEW", expires_at: "2026-11-13T10:00:00Z", race_date: null }],
        auto_stop_at: "2026-11-13T10:00:00Z",
        workloads: { raceday: false, batch: false },
      },
      errors: [],
    });
    assert.match(text, /運用モード: \*\*STARTING\*\*/);
    assert.match(text, /準備完了まで表示しない/);
    assert.match(text, /VIEW 〜2026-11-13T10:00:00Z/);
    assert.match(text, /自動停止の予定: 2026-11-13T10:00:00Z/);
  });
});
