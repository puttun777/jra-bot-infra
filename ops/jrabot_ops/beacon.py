"""モードビーコン（web CONTRACTS §7.2）。署名は Ed25519、canonical は sig を除いたキーの辞書順・空白なしの JSON（エージェントの検証と同一）。"""
from __future__ import annotations

import base64
import json

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def canonical_bytes(doc: dict) -> bytes:
    body = {k: v for k, v in doc.items() if k != "sig"}
    return json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def private_key_from_secret(secret: str) -> Ed25519PrivateKey:
    """Secret Manager の `beacon-signing-key`（Ed25519 の生 32 バイトの秘密鍵を Base64）。"""
    raw = base64.b64decode(secret.strip())
    if len(raw) != 32:
        raise ValueError("beacon-signing-key は Ed25519 の生 32 バイト（Base64）であること")
    return Ed25519PrivateKey.from_private_bytes(raw)


def make_beacon(key: Ed25519PrivateKey, kid: str, mode: str, seq: int, updated_at: str, valid_until: str | None = None) -> bytes:
    doc = {"schema_version": 1, "mode": mode, "seq": seq, "updatedAt": updated_at, "validUntil": valid_until, "kid": kid}
    doc["sig"] = b64url(key.sign(canonical_bytes(doc)))
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
