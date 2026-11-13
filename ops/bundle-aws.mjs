// AWS の制御（Lambda）とホストの運用エージェントを、それぞれ 1 つの ES モジュールにまとめる（esbuild。依存の AWS SDK・zod も含める。
// Lambda の実行環境に同梱の SDK の版に頼らない: 版数は package-lock.json で固定）。出力: build/aws/lambda/index.mjs・build/aws/host/jrabot-host.mjs

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  legalComments: "eof",
  logLevel: "warning",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
};
await build({ ...common, entryPoints: ["ops/src/aws/lambda.ts"], outfile: "build/aws/lambda/index.mjs" });
await build({
  ...common,
  entryPoints: ["ops/src/aws/hostctl.ts"],
  outfile: "build/aws/host/jrabot-host.mjs",
  define: { "process.env.JRABOT_HOSTCTL": '"1"' },
});
for (const f of ["build/aws/lambda/index.mjs", "build/aws/host/jrabot-host.mjs"]) {
  const sha = createHash("sha256").update(readFileSync(f)).digest("hex");
  writeFileSync(`${f}.sha256`, `${sha}  ${f.split("/").at(-1)}\n`);
  console.log(`${f} ${(readFileSync(f).length / 1024).toFixed(0)} KiB sha256=${sha}`);
}
