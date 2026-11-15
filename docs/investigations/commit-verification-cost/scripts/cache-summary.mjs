// Adds one row to data/cache/cache-cells.csv for a finished cache cell: hits, misses and times from
// the cache log, the grid row of the cell (wall, user, sys, rewritten, tree-changed), and the
// uncached wall of the same operation and N from data/ops-cells.csv (median of its repeats).
// Usage: cache-summary.mjs <out-dir> <grid-cell-name> <cell-name> <cache-log>
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [, , out, src, cell, logFile] = process.argv;
const HEADER =
  "cell,n,op,rep,hits,misses,bypass,failed,verify_wall_s,verify_user_s,verify_sys_s,hit_commits_s,miss_commits_s,checked,rewritten,tree_changed,uncached_wall_s,uncached_user_s,uncached_sys_s";
const csvRows = (f) => {
  const [h, ...r] = readFileSync(f, "utf8").trim().split("\n");
  const cols = h.split(",");
  return r.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));
};
const grid = csvRows(join(out, "ops-cells.csv"))
  .filter((r) => r.cell === src)
  .pop();
if (!grid) {
  console.error(`no grid row ${src}`);
  process.exit(1);
}
const lines = existsSync(logFile)
  ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean)
  : [];
const rows = lines.map((l) => l.split("\t"));
const count = (k) => rows.filter((r) => r[2] === k).length;
const secs = (k) => rows.filter((r) => r[2] === k).reduce((a, r) => a + Number(r[5]), 0);
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : "";
};
const base = csvRows(join(dirname(out), "ops-cells.csv")).filter(
  (r) =>
    r.n === grid.n &&
    r.op === grid.op &&
    r.exit === "0" &&
    !r.cell.startsWith("pk-") &&
    !r.cell.startsWith("pr-"),
);
const med = (k) => median(base.map((r) => Number(r[k])));
const row = [
  cell,
  grid.n,
  cell.replace(/^cn\d+-/, "").replace(/-r\d+$/, ""),
  cell.replace(/^.*-r/, ""),
  count("hit"),
  count("miss"),
  count("bypass"),
  rows.filter((r) => r[4] !== "0").length,
  grid.verify_wall_s,
  grid.verify_user_s,
  grid.verify_sys_s,
  secs("hit").toFixed(2),
  secs("miss").toFixed(2),
  grid.checked,
  grid.rewritten,
  grid.tree_changed,
  med("verify_wall_s"),
  med("verify_user_s"),
  med("verify_sys_s"),
];
const file = join(out, "cache-cells.csv");
if (!existsSync(file)) writeFileSync(file, `${HEADER}\n`);
appendFileSync(file, `${row.join(",")}\n`);
console.log(row.join(","));
