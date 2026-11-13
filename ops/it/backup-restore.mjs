// バックアップ・復元の結合試験（合成データだけ。実データ・実 AWS は使わない）。hostctl と同じ mysqldump の引数で dump → gzip →
// 終わりの行の確認 → 別の MySQL へ流し込み → 全表のチェックサム・件数を比べる。CI（infra の backup-restore ジョブ）とローカルで実行する。
//   node ops/it/backup-restore.mjs                    合成のスキーマとデータを作って試す
//   SOURCE_CONTAINER=<name> SOURCE_ROOT_PW=<pw> node ops/it/backup-restore.mjs   既存のコンテナ（例: web の Flyway のスキーマ + 合成データ）から試す
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MYSQLDUMP_ARGS } from "../../build/ops/src/aws/host.js";

const IMAGE = process.env.MYSQL_IMAGE ?? "mysql:8.4";
const sh = (cmd, input) => {
  const r = spawnSync("bash", ["-o", "pipefail", "-c", cmd], { encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`失敗(${r.status}): ${cmd.slice(0, 120)}\n${(r.stderr ?? "").slice(-500)}`);
  return r.stdout;
};
const pw = randomBytes(12).toString("hex");
const started = [];
function startMysql(name) {
  sh(`docker run -d --name ${name} -e MYSQL_ROOT_PASSWORD=${pw} ${IMAGE} --performance-schema=OFF --innodb-buffer-pool-size=64M`);
  started.push(name);
  for (let i = 0; i < 90; i++) {
    const r = spawnSync("docker", ["exec", name, "mysql", "-uroot", `-p${pw}`, "-e", "SELECT 1"], { encoding: "utf8" });
    if (r.status === 0) return;
    spawnSync("sleep", ["2"]);
  }
  throw new Error(`${name} が起動しない`);
}
const mysql = (name, rootPw, sql) => sh(`docker exec -i ${name} mysql -uroot -p'${rootPw}' --batch --skip-column-names`, sql);

const work = mkdtempSync(join(tmpdir(), "jrabot-br-"));
let ok = false;
try {
  let src = process.env.SOURCE_CONTAINER;
  let srcPw = process.env.SOURCE_ROOT_PW ?? pw;
  if (src === undefined) {
    src = `jrabot-br-src-${randomBytes(3).toString("hex")}`;
    startMysql(src);
    srcPw = pw;
    // 合成のスキーマ: 本番の型（DATETIME(6)・DOUBLE・utf8mb4 の日本語・ENUM・複合 FK・生成列・トリガー）を含む
    mysql(
      src,
      srcPw,
      `
      CREATE DATABASE jrabot CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; USE jrabot;
      CREATE TABLE tenant (tenant_id BIGINT PRIMARY KEY, name VARCHAR(100) NOT NULL, created_at DATETIME(6) NOT NULL);
      CREATE TABLE races (tenant_id BIGINT, race_id CHAR(12) CHARACTER SET ascii COLLATE ascii_bin, name VARCHAR(100), post DATETIME(6),
        PRIMARY KEY (tenant_id, race_id), FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id));
      CREATE TABLE odds (tenant_id BIGINT, race_id CHAR(12) CHARACTER SET ascii COLLATE ascii_bin, umaban TINYINT UNSIGNED, odds DOUBLE,
        market ENUM('win','wide') NOT NULL, observed_at DATETIME(6), PRIMARY KEY (tenant_id, race_id, umaban, observed_at),
        FOREIGN KEY (tenant_id, race_id) REFERENCES races (tenant_id, race_id));
      CREATE TABLE ev (id BIGINT AUTO_INCREMENT PRIMARY KEY, a DOUBLE, b DOUBLE, s DOUBLE AS (a * b) STORED, note TEXT);
      CREATE TABLE audit (id BIGINT AUTO_INCREMENT PRIMARY KEY, what VARCHAR(50));
      CREATE TRIGGER ev_ai AFTER INSERT ON ev FOR EACH ROW INSERT INTO audit (what) VALUES (CONCAT('ev ', NEW.id));
      INSERT INTO tenant VALUES (1, '合成テナント', '2026-11-14 01:00:00.123456');`,
    );
    let rows = "";
    for (let r = 1; r <= 12; r++) {
      const id = `20261114050${r.toString().padStart(1, "0")}`.slice(0, 10) + String(r).padStart(2, "0");
      rows += `INSERT INTO races VALUES (1, '${id}', '合成レース${r}（テスト）', '2026-11-14 0${r % 9}:55:00.000001');`;
      const vals = [];
      for (let h = 1; h <= 16; h++)
        for (let k = 0; k < 20; k++)
          vals.push(
            `(1,'${id}',${h},${(1.1 + h * h * 0.37 + k / 7).toFixed(6)},'win','2026-11-14 01:${String(k).padStart(2, "0")}:00.${String(h).padStart(6, "0")}')`,
          );
      rows += `INSERT INTO odds VALUES ${vals.join(",")};`;
    }
    for (let i = 0; i < 500; i++) rows += `INSERT INTO ev (a, b, note) VALUES (${Math.PI * i}, ${Math.E / (i + 1)}, '期待値 ${i} 😀');`;
    mysql(src, srcPw, `USE jrabot; ${rows}`);
  }
  const dump = join(work, "jrabot.sql.gz");
  sh(`docker exec ${src} mysqldump -uroot -p'${srcPw}' ${MYSQLDUMP_ARGS.join(" ")} 2>/dev/null | gzip -6 > '${dump}'`);
  if (statSync(dump).size < 200) throw new Error("dump が小さすぎる");
  if (!sh(`gzip -dc '${dump}' | tail -n 1`).includes("Dump completed")) throw new Error("dump の終わりの行が無い");
  const dst = `jrabot-br-dst-${randomBytes(3).toString("hex")}`;
  startMysql(dst);
  sh(`gzip -dc '${dump}' | docker exec -i ${dst} mysql -uroot -p'${pw}'`);
  const tables = mysql(
    src,
    srcPw,
    "SELECT table_name FROM information_schema.tables WHERE table_schema='jrabot' AND table_type='BASE TABLE' ORDER BY 1;",
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  if (tables.length === 0) throw new Error("表が無い");
  const sum = (name, p) => mysql(name, p, `CHECKSUM TABLE ${tables.map((t) => `jrabot.\`${t}\``).join(", ")} EXTENDED;`);
  const count = (name, p) => mysql(name, p, tables.map((t) => `SELECT '${t}', COUNT(*) FROM jrabot.\`${t}\`;`).join(" "));
  const [a, b] = [sum(src, srcPw), sum(dst, pw)];
  if (a !== b) throw new Error(`チェックサムが一致しない\n${a}\n${b}`);
  if (count(src, srcPw) !== count(dst, pw)) throw new Error("件数が一致しない");
  const triggers = mysql(dst, pw, "SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema='jrabot';").trim();
  console.log(`backup-restore: OK（表 ${tables.length}・チェックサム一致・トリガー ${triggers}・dump ${statSync(dump).size} bytes）`);
  ok = true;
} finally {
  for (const c of started) spawnSync("docker", ["rm", "-f", c]);
  rmSync(work, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
