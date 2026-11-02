/**
 * モードビーコン（web CONTRACTS §7.2）。署名は Ed25519、署名対象は sig を除いたキーの辞書順・空白なしの JSON（エージェントの検証と同一）。
 * 旧 ops/jrabot_ops/beacon.py の移植。互換性は削除前の Python 実装で生成したベクトル（test/vectors/beacon_vectors.json）でバイト単位に検証する。
 */
import { createPrivateKey, createPublicKey, type KeyObject, sign, verify } from "node:crypto";
import { canonicalString } from "./json.js";

/** Ed25519 の生 32 バイトの秘密鍵を PKCS#8 DER に包むための接頭辞（RFC 8410） */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface BeaconKey {
  readonly privateKey: KeyObject;
  readonly kid: string;
}

/** Secret Manager の `beacon-signing-key`（Ed25519 の生 32 バイトの秘密鍵を Base64）。値はログに出さない。 */
export function privateKeyFromSecret(secret: string): KeyObject {
  const text = secret.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error("beacon-signing-key は Base64 であること");
  const raw = Buffer.from(text, "base64");
  if (raw.length !== 32) throw new Error("beacon-signing-key は Ed25519 の生 32 バイト（Base64）であること");
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, raw]), format: "der", type: "pkcs8" });
}

export function publicKeyRaw(privateKey: KeyObject): Buffer {
  const der = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - 32));
}

export interface BeaconDoc {
  readonly schema_version: 1;
  readonly mode: string;
  readonly seq: number;
  readonly updatedAt: string;
  readonly validUntil: string | null;
  readonly kid: string;
}

export function canonicalBytes(doc: Readonly<Record<string, unknown>>): Buffer {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) if (k !== "sig") body[k] = v;
  return Buffer.from(canonicalString(body), "utf8");
}

function b64url(raw: Buffer): string {
  return raw.toString("base64url");
}

/** 署名済みのビーコン（UTF-8 の JSON。キー順は schema_version, mode, seq, updatedAt, validUntil, kid, sig）。 */
export function makeBeacon(
  key: KeyObject,
  kid: string,
  mode: string,
  seq: number,
  updatedAt: string,
  validUntil: string | null = null,
): Buffer {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("seq は 1 以上の安全な整数");
  const doc: BeaconDoc = { schema_version: 1, mode, seq, updatedAt, validUntil, kid };
  const sig = b64url(sign(null, canonicalBytes({ ...doc }), key));
  return Buffer.from(JSON.stringify({ ...doc, sig }), "utf8");
}

export function verifyBeacon(raw: Buffer, publicKey: KeyObject): boolean {
  const doc: unknown = JSON.parse(raw.toString("utf8"));
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return false;
  const rec: Record<string, unknown> = { ...doc };
  const sig = rec["sig"];
  if (typeof sig !== "string") return false;
  return verify(null, canonicalBytes(rec), publicKey, Buffer.from(sig, "base64url"));
}
