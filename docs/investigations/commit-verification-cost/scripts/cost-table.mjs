// Groups the cells of data/ops-cells.csv by window, operation and N and writes data/cost-table.csv:
// the median verification wall time and machine time (user plus system CPU seconds), the range of
// the wall time, the repeats, and the commits rewritten and with a changed tree. Also prints the
// table as Markdown. The medians and counts are measured, nothing is modelled here.
// Usage: node cost-table.mjs [--data DIR]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataIdx = process.argv.indexOf("--data");
const data = dataIdx > 0 ? process.argv[dataIdx + 1] : join(here, "..", "data");

const lines = readFileSync(join(data, "ops-cells.csv"), "utf8").trim().split("\n");
const head = lines[0].split(",");
const cells = lines.slice(1).map((l) => {
  const v = l.split(",");
  const o = Object.fromEntries(head.map((h, i) => [h, v[i]]));
  for (const k of head) if (k !== "cell" && k !== "op") o[k] = Number(o[k]);
  o.window = o.cell.startsWith("pk-") ? "pk" : o.cell.startsWith("pr-") ? "pr" : "old";
  return o;
});

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const groups = new Map();
for (const c of cells) {
  const key = `${c.window}|${c.op}|${c.n}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(c);
}
const order = { old: 0, pk: 1, pr: 2 };
const rows = [...groups.values()]
  .map((g) => ({
    window: g[0].window,
    op: g[0].op,
    n: g[0].n,
    repeats: g.length,
    exit_nonzero: g.filter((c) => c.exit !== 0).length,
    checked: median(g.map((c) => c.checked)),
    rewritten: median(g.map((c) => c.rewritten)),
    tree_changed: median(g.map((c) => c.tree_changed)),
    wall_median_s: median(g.map((c) => c.verify_wall_s)),
    wall_min_s: Math.min(...g.map((c) => c.verify_wall_s)),
    wall_max_s: Math.max(...g.map((c) => c.verify_wall_s)),
    machine_median_s: median(g.map((c) => c.verify_user_s + c.verify_sys_s)),
  }))
  .sort((a, b) => order[a.window] - order[b.window] || a.n - b.n || a.op.localeCompare(b.op));

const cols = Object.keys(rows[0]);
const f = (x) => (typeof x === "number" && !Number.isInteger(x) ? x.toFixed(1) : String(x));
writeFileSync(
  join(data, "cost-table.csv"),
  `${[cols.join(","), ...rows.map((r) => cols.map((c) => f(r[c])).join(","))].join("\n")}\n`,
);
console.log(
  "| Window | Operation | N | Repeats | Wall (range) | Machine time | Rewritten | Tree changed |",
);
console.log("|---|---|---|---|---|---|---|---|");
for (const r of rows)
  console.log(
    `| ${r.window} | ${r.op} | ${r.n} | ${r.repeats} | ${f(r.wall_median_s)} (${f(r.wall_min_s)}-${f(r.wall_max_s)}) | ${f(r.machine_median_s)} | ${r.rewritten} | ${r.tree_changed} |`,
  );
