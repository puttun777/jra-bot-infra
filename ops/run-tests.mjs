// ops の単体試験を実行し、JUnit XML の testcase を数えて件数・skip/todo・失敗を検証する（0 件・skip を成功にしない）。
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIN = 109;
const dir = "build/ops/test";
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.js"))
  .sort()
  .map((f) => join(dir, f));
if (files.length === 0) {
  console.error("::error::試験ファイルが無い（npm run build を先に実行）");
  process.exit(1);
}
mkdirSync("build/ops-test", { recursive: true });
const out = "build/ops-test/junit.xml";
const r = spawnSync(
  process.execPath,
  [
    "--test",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=junit",
    `--test-reporter-destination=${out}`,
    ...files,
  ],
  { stdio: "inherit" },
);
const xml = readFileSync(out, "utf8");
const cases = xml.match(/<testcase\b[^>]*?(\/>|>[\s\S]*?<\/testcase>)/g) ?? [];
const skipped = cases.filter((c) => c.includes("<skipped")).length;
const failed = cases.filter((c) => c.includes("<failure") || c.includes("<error")).length;
console.log(`ops (TypeScript): tests=${cases.length} skipped=${skipped} failures=${failed}`);
if (r.status !== 0 || cases.length < MIN || skipped > 0 || failed > 0) {
  console.error(`::error::ops の試験: 件数不足(最小 ${MIN})・スキップ・失敗のいずれか`);
  process.exit(1);
}
