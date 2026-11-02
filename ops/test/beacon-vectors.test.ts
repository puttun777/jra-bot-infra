/**
 * ビーコンの通信互換性: 削除前の Python 実装（ops/jrabot_ops/beacon.py, cryptography 50.0.2。生成元コミットはベクトルのファイルに記録）で生成したベクトルと、
 * TS 版の正準形・署名・出力バイト列が**完全一致**すること（Ed25519 は決定的）。型が合うだけでなく、エージェント・Kotlin が検証する形そのものを比べる。
 */
import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { canonicalBytes, makeBeacon, privateKeyFromSecret, publicKeyRaw, verifyBeacon } from "../src/beacon.js";

interface Case {
  secret_b64: string;
  public_key_b64: string;
  kid: string;
  mode: string;
  seq: string;
  updated_at: string;
  valid_until: string | null;
  canonical_utf8: string;
  beacon_utf8: string;
}
const doc = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "..", "ops", "test", "vectors", "beacon_vectors.json"), "utf8"),
) as { generated_at_commit: string; cases: Case[] };

describe("beacon vectors (Python-generated)", () => {
  it("has the expected provenance and cases", () => {
    assert.match(doc.generated_at_commit, /^[0-9a-f]{40}$/);
    assert.equal(doc.cases.length, 8);
  });
  for (const [i, c] of doc.cases.entries()) {
    it(`case ${i}: ${c.mode} seq=${c.seq} kid=${c.kid}`, () => {
      const key = privateKeyFromSecret(c.secret_b64);
      assert.equal(publicKeyRaw(key).toString("base64"), c.public_key_b64);
      const seq = Number(c.seq);
      if (!Number.isSafeInteger(seq)) {
        // 2^53 を超える seq は number で表せない。黙って丸めた署名を作らず、拒否する（ops-state 側も同じ値を拒否する）
        assert.throws(() => makeBeacon(key, c.kid, c.mode, seq, c.updated_at, c.valid_until), /安全な整数/);
        return;
      }
      const raw = makeBeacon(key, c.kid, c.mode, seq, c.updated_at, c.valid_until);
      assert.equal(raw.toString("utf8"), c.beacon_utf8, "出力のバイト列（キー順・区切り・非 ASCII・署名）が Python と同一");
      assert.equal(canonicalBytes(JSON.parse(c.beacon_utf8) as Record<string, unknown>).toString("utf8"), c.canonical_utf8);
      const pub = createPublicKey({
        key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(c.public_key_b64, "base64")]),
        format: "der",
        type: "spki",
      });
      assert.equal(verifyBeacon(Buffer.from(c.beacon_utf8, "utf8"), pub), true);
      const tampered = Buffer.from(c.beacon_utf8.replace(`"seq":${c.seq}`, `"seq":${seq + 1}`), "utf8");
      assert.equal(verifyBeacon(tampered, pub), false);
    });
  }
  it("rejects malformed secrets", () => {
    for (const bad of ["", "not base64!", Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64")])
      assert.throws(() => privateKeyFromSecret(bad));
  });
});
