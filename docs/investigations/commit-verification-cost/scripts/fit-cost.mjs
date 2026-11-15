// Derives the cost-over-N tables from the raw cells (data/ops-cells.csv, data/ops/*.jsonl,
// *.pre.json, *.post.json). Writes, next to the data:
//   fit.csv             fixed and per-commit part per operation (least squares on verify_wall_s vs N)
//   kind-costs.csv      measured wall time per commit kind, per window
//   cost-along-branch.csv   per-commit wall time and the running total along a branch
//   model-vs-measured.csv   kind-weighted model (per-kind costs of check-commit.csv) against cells
//   first-failure.csv       time to the first failure for a broken commit at first, middle, last
//   rewrite-counts.csv      commits rewritten vs tree-changed per operation and N, with the time a
//                           check that skips unchanged (tree, parent tree) pairs would save
// Usage: node fit-cost.mjs [--data DIR]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataIdx = process.argv.indexOf("--data");
const data = dataIdx > 0 ? process.argv[dataIdx + 1] : join(here, "..", "data");
const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : "");
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "");

const csv = readFileSync(join(data, "ops-cells.csv"), "utf8").trim().split("\n");
const head = csv[0].split(",");
const cells = csv.slice(1).map((l) => {
  const v = l.split(",");
  const o = Object.fromEntries(head.map((h, i) => [h, v[i]]));
  for (const k of head)
    if (k !== "cell" && k !== "op") o[k] = o[k] === "" ? Number.NaN : Number(o[k]);
  o.window = o.cell.startsWith("pk-") ? "pk" : o.cell.startsWith("pr-") ? "pr" : "old";
  return o;
});
const rows = (cell) => {
  const p = join(data, "ops", `${cell}.jsonl`);
  return existsSync(p)
    ? readFileSync(p, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
};
const json = (cell, kind) =>
  JSON.parse(readFileSync(join(data, "ops", `${cell}.${kind}.json`), "utf8"));
const kindOf = (r) => (r.mode === "pkg" ? `pkg:${r.pkgs}` : r.mode);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// Least squares y = X b by the normal equations (Gaussian elimination); returns b and r2.
function ols(X, y) {
  const k = X[0].length;
  const A = Array.from({ length: k }, (_, i) => [
    ...Array.from({ length: k }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0)),
    X.reduce((s, r, n) => s + r[i] * y[n], 0),
  ]);
  for (let i = 0; i < k; i++) {
    let p = i;
    for (let r = i + 1; r < k; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    for (let r = 0; r < k; r++) {
      if (r === i) continue;
      const m = A[r][i] / A[i][i];
      for (let c = i; c <= k; c++) A[r][c] -= m * A[i][c];
    }
  }
  const b = A.map((r, i) => r[k] / r[i]);
  const my = mean(y);
  const ssr = y.reduce((s, v, n) => s + (v - X[n].reduce((t, x, i) => t + x * b[i], 0)) ** 2, 0);
  const sst = y.reduce((s, v) => s + (v - my) ** 2, 0);
  return { b, r2: sst === 0 ? Number.NaN : 1 - ssr / sst };
}

// 1. Per-operation fit. Cells that failed (exit not 0) or are not a plain operation are left out.
const plain = (c) => c.exit === 0 && c.checked === c.n && !/^(break|alone)/.test(c.op);
const fit = ["cell,window,op,points,distinct_n,fixed_s,per_commit_s,r2,basis"];
fit.length = 0;
fit.push("window,op,points,distinct_n,fixed_s,per_commit_s,r2,basis,note");
for (const w of ["pk", "old"]) {
  const ops = [...new Set(cells.filter((c) => c.window === w && plain(c)).map((c) => c.op))];
  for (const op of ops) {
    const cs = cells.filter((c) => c.window === w && c.op === op && plain(c));
    const ns = new Set(cs.map((c) => c.n));
    if (ns.size >= 2) {
      const { b, r2 } = ols(
        cs.map((c) => [1, c.n]),
        cs.map((c) => c.verify_wall_s),
      );
      fit.push(
        [
          w,
          op,
          cs.length,
          ns.size,
          f1(b[0]),
          f1(b[1]),
          f3(r2),
          "measured fit",
          w === "old" ? "mixed commit kinds; see kind-costs.csv" : "package-testing commits",
        ].join(","),
      );
    } else {
      const n = [...ns][0];
      fit.push(
        [
          w,
          op,
          cs.length,
          1,
          "",
          f1(mean(cs.map((c) => c.verify_wall_s / n))),
          "",
          "derived (one N)",
          `wall over ${n} commits`,
        ].join(","),
      );
    }
  }
}

// 2. Kind-weighted fit on the per-commit rows of the largest "first" run of the mixed window:
//    running total(N) = a + b*N + c*(package commits among the first N).
const big = rows("n20-first-r1");
if (big.length) {
  const cum = [];
  let run = 0;
  let pk = 0;
  big.forEach((r, i) => {
    run += r.wall_s;
    if (r.mode === "pkg") pk += 1;
    cum.push({ n: i + 1, run, pk });
  });
  const { b, r2 } = ols(
    cum.map((c) => [1, c.n, c.pk]),
    cum.map((c) => c.run),
  );
  fit.push(
    [
      "old",
      "first; kind-weighted (running total over the 20 prefixes)",
      cum.length,
      cum.length,
      f1(b[0]),
      `${f1(b[1])} per commit + ${f1(b[2])} per package commit`,
      f3(r2),
      "derived from measured rows",
      "total(N) = fixed + per_commit*N + package*Npkg",
    ].join(","),
  );
}
writeFileSync(join(data, "fit.csv"), `${fit.join("\n")}\n`);

// 3. Cost per commit kind: every checked commit of the clean "first" cells, per window.
const kinds = {};
for (const c of cells.filter((c) => c.op === "first" && c.exit === 0)) {
  for (const r of rows(c.cell)) {
    const key = `${c.window},${kindOf(r)}`;
    kinds[key] ??= { walls: [], tests: [] };
    kinds[key].walls.push(r.wall_s);
    kinds[key].tests.push(r.tests);
  }
}
const kc = ["window,kind,observations,mean_wall_s,min_wall_s,max_wall_s,mean_tests,basis"];
for (const [k, v] of Object.entries(kinds).sort())
  kc.push(
    [
      k,
      v.walls.length,
      f3(mean(v.walls)),
      f3(Math.min(...v.walls)),
      f3(Math.max(...v.walls)),
      f1(mean(v.tests)),
      "measured",
    ].join(","),
  );
writeFileSync(join(data, "kind-costs.csv"), `${kc.join("\n")}\n`);

// 4. Cost along the branch.
const along = ["cell,seq,sha,kind,wall_s,running_total_s,tests,subject"];
for (const cell of [
  "n20-first-r1",
  "pk-n02-first-r1",
  "pk-n02-first-r2",
  "pk-n02-alone-2-r1",
  "pk-n03-alone-3-r1",
]) {
  let run = 0;
  for (const r of rows(cell)) {
    run += r.wall_s;
    along.push(
      [
        cell,
        r.seq,
        r.sha,
        kindOf(r),
        f3(r.wall_s),
        f3(run),
        r.tests,
        JSON.stringify(r.subject.slice(0, 60)),
      ].join(","),
    );
  }
}
writeFileSync(join(data, "cost-along-branch.csv"), `${along.join("\n")}\n`);

// 5. Kind-weighted model with the per-kind costs of check-commit.csv (an independent measurement,
//    taken on the newest commit): docs 0.6, log 5.0, issues 171, adr 264, ledger and full 281.
const perKind = {
  docs: 0.6,
  log: 5.0,
  "pkg:issues": 171,
  "pkg:adr": 264,
  "pkg:adr+issues": 264,
  "pkg:ledger": 281,
  "pkg:adr+issues+ledger": 281,
  full: 281,
};
const mvm = ["cell,window,n,op,measured_s,model_s,error_pct,basis"];
for (const c of cells.filter((c) => plain(c) && c.op === "first")) {
  const rs = rows(c.cell);
  const model = rs.reduce((s, r) => s + (perKind[kindOf(r)] ?? Number.NaN), 0);
  mvm.push(
    [
      c.cell,
      c.window,
      c.n,
      c.op,
      f1(c.verify_wall_s),
      f1(model),
      f1(((model - c.verify_wall_s) / c.verify_wall_s) * 100),
      "measured vs modelled",
    ].join(","),
  );
}
writeFileSync(join(data, "model-vs-measured.csv"), `${mvm.join("\n")}\n`);

// 6. Time to first failure.
const ff = [
  "cell,broken_commit,kind,position,n,checked,verify_wall_s,machine_s,clean_run_estimate_s,saved_pct,basis",
];
for (const c of cells.filter((c) => c.op.startsWith("break-"))) {
  const [, kind, pos] = c.op.split("-");
  const rs = rows(c.cell);
  const clean = c.n * mean(rows("pk-n02-first-r1").map((r) => r.wall_s));
  ff.push(
    [
      c.cell,
      pos,
      kind,
      { first: 1, mid: Math.ceil(c.n / 2), last: c.n }[pos],
      c.n,
      c.checked,
      f1(c.verify_wall_s),
      f1(c.verify_user_s + c.verify_sys_s),
      f1(clean),
      f1((1 - c.verify_wall_s / clean) * 100),
      `measured; clean run derived (N x mean pk commit)${rs.length ? "" : ""}`,
    ].join(","),
  );
}
writeFileSync(join(data, "first-failure.csv"), `${ff.join("\n")}\n`);

// 7. Rewritten vs tree-changed, and what skipping unchanged (tree, parent tree) pairs would save.
const rw = [
  "cell,window,n,op,checked,rewritten,tree_changed,patch_changed,msg_changed,verify_wall_s,skippable_commits,skippable_s,skippable_pct,basis",
];
for (const c of cells.filter((c) => c.exit === 0 && !/^(break|alone)/.test(c.op))) {
  const pre = json(c.cell, "pre");
  const seen = new Set();
  let prev = "base";
  for (const p of pre) {
    seen.add(`${p.tree}|${prev}`);
    prev = p.tree;
  }
  let skip = 0;
  let skipS = 0;
  prev = "base";
  const post = json(c.cell, "post");
  const rs = rows(c.cell);
  post.forEach((p, i) => {
    const same = seen.has(`${p.tree}|${prev}`) && c.op !== "rebase";
    if (same && rs[i]) {
      skip += 1;
      skipS += rs[i].wall_s;
    }
    prev = p.tree;
  });
  rw.push(
    [
      c.cell,
      c.window,
      c.n,
      c.op,
      c.checked,
      c.rewritten,
      c.tree_changed,
      c.patch_changed,
      c.msg_changed,
      f1(c.verify_wall_s),
      skip,
      f1(skipS),
      f1((skipS / c.verify_wall_s) * 100),
      "counts measured; saving derived",
    ].join(","),
  );
}
writeFileSync(join(data, "rewrite-counts.csv"), `${rw.join("\n")}\n`);
console.log(fit.join("\n"));
