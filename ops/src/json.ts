/** JSON の道具（any を使わない）。正準形はキーをコードポイント順・空白なし（web CONTRACTS §5.1 / §7.2 と同じ）。 */

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function compareCodePoints(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/**
 * 正準 JSON。数値は**安全な整数**と bigint だけを受け付ける（浮動小数・2^53 以上の number は表現の一致を保証できないので拒否 = fail closed）。
 * ops-state・ビーコンの値は整数・文字列・真偽・null・配列・オブジェクトだけ。
 */
export function canonicalString(v: unknown, path = "$"): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "bigint") return v.toString(10);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error(`${path}: 安全な整数以外の数値は正準化できない: ${v}`);
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map((x, i) => canonicalString(x, `${path}[${i}]`)).join(",")}]`;
  if (isRecord(v)) {
    const keys = Object.keys(v).sort(compareCodePoints);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalString(v[k], `${path}.${k}`)}`).join(",")}}`;
  }
  throw new Error(`${path}: JSON の値ではない (${typeof v})`);
}

export function canonicalEqual(a: unknown, b: unknown): boolean {
  return canonicalString(a) === canonicalString(b);
}

export function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${what} が JSON として読めない: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
