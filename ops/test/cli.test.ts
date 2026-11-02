/** CLI の終了コード（旧 ops/tests/test_cli.py + 引数の誤り = 2）。実 GCP には接続しない。 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { main } from "../src/cli.js";

function planFile(rcs: unknown[]): string {
  const d = mkdtempSync(join(tmpdir(), "plan-"));
  const f = join(d, "plan.json");
  writeFileSync(f, JSON.stringify({ resource_changes: rcs }));
  return f;
}
const quiet = async (argv: string[]): Promise<number> => {
  const [l, e] = [console.log, console.error];
  console.log = () => {};
  console.error = () => {};
  try {
    return await main(argv);
  } finally {
    console.log = l;
    console.error = e;
  }
};

describe("cli", () => {
  it("plan-guard exit codes", async () => {
    const bad = planFile([
      {
        address: "a",
        type: "google_cloud_scheduler_job",
        change: { actions: ["update"], before: { paused: true }, after: { paused: false } },
      },
    ]);
    assert.equal(await quiet(["plan-guard", "--plan-json", bad, "--mode", "NORMAL"]), 3);
    assert.equal(await quiet(["plan-guard", "--plan-json", planFile([]), "--mode", "NORMAL"]), 0);
  });
  it("arguments are required and validated (exit 2)", async () => {
    assert.equal(await quiet(["start", "--project", "p"]), 2);
    assert.equal(await quiet(["stop", "--project", "p", "--actor", "a", "--run-id", "r", "--drain-timeout-min", "-1"]), 2);
    assert.equal(await quiet(["plan-guard", "--plan-json", planFile([]), "--mode", "WHATEVER"]), 2);
    assert.equal(await quiet(["start", "--unknown-flag"]), 2);
    assert.equal(await quiet(["nonsense"]), 2);
    // deploy は dry-run・force を受け付けない（黙って無視して本番を更新しない）
    for (const flag of ["--dry-run", "--force"]) {
      assert.equal(
        await quiet(["deploy", "--project", "p", "--actor", "a", "--run-id", "r", "--manifest", "m.json", "--schema", "s.json", flag]),
        2,
        flag,
      );
    }
  });
});
