// Turns the raw CSV and JSON files in data/ into median/range tables (plain text, Markdown pipes).
//
//   node summarize.mjs [--data <dir>]  > data/summary.txt
//
// Every table is computed from the files in data/; nothing is typed in by hand.
// Times are seconds. cpu = user + sys of the command and its descendants (machine time).
// "range" is min-max over the repeats.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const data = resolve(args.includes("--data") ? args[args.indexOf("--data") + 1] : "data");

const read = (name) => {
  const f = join(data, name);
  if (!existsSync(f)) return [];
  const [head, ...lines] = readFileSync(f, "utf8").trim().split("\n");
  const cols = head.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));
};
const num = (x) => Number(x);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const f1 = (x) => x.toFixed(1);
const stat = (xs, f = f1) => `${f(median(xs))} (${f(Math.min(...xs))}-${f(Math.max(...xs))})`;
const group = (rows, key) => {
  const m = new Map();
  for (const r of rows) {
    const k = key(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
};
const table = (title, head, rows) => {
  console.log(`\n## ${title}\n`);
  console.log(`| ${head.join(" | ")} |`);
  console.log(`|${head.map(() => "---").join("|")}|`);
  for (const r of rows) console.log(`| ${r.join(" | ")} |`);
};
const cpu = (r) => num(r.user_s) + num(r.sys_s);

const phases = read("phases.csv");
if (phases.length) {
  table(
    "phases (median (min-max) seconds)",
    ["phase", "runs", "wall", "cpu", "cpu/wall"],
    [...group(phases, (r) => r.phase)].map(([k, rs]) => [
      k,
      rs.length,
      stat(
        rs.map((r) => num(r.wall_s)),
        (x) => x.toFixed(2),
      ),
      stat(rs.map(cpu), (x) => x.toFixed(2)),
      f1(median(rs.map((r) => cpu(r) / num(r.wall_s)))),
    ]),
  );
}

const cc = read("check-commit.csv");
if (cc.length) {
  table(
    "scripts/check-commit.sh per commit kind (median (min-max) seconds)",
    ["mode", "runs", "failed runs", "wall", "cpu", "cpu/wall"],
    [...group(cc, (r) => r.mode)].map(([k, rs]) => [
      k,
      rs.length,
      rs.filter((r) => r.exit !== "0").length,
      stat(
        rs.map((r) => num(r.wall_s)),
        (x) => x.toFixed(1),
      ),
      stat(rs.map(cpu), (x) => x.toFixed(1)),
      f1(median(rs.map((r) => cpu(r) / num(r.wall_s)))),
    ]),
  );
}

const pk = read("packages.csv");
if (pk.length) {
  table(
    "package test runs (median (min-max) seconds)",
    ["package", "workers", "runs", "failed runs", "wall", "cpu", "cpu/wall"],
    [...group(pk, (r) => `${r.package},${r.workers}`)]
      .sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: true }))
      .map(([k, rs]) => {
        const [p, w] = k.split(",");
        return [
          p,
          w,
          rs.length,
          rs.filter((r) => r.exit !== "0").length,
          stat(rs.map((r) => num(r.wall_s))),
          stat(rs.map(cpu)),
          f1(median(rs.map((r) => cpu(r) / num(r.wall_s)))),
        ];
      }),
  );
  // whole suite, packages one after another (pnpm -r run test), per run id and worker setting
  const whole = [];
  for (const [k, rs] of group(pk, (r) => `${r.workers},${r.run}`)) {
    const pkgs = new Set(rs.map((r) => r.package));
    if (pkgs.size < 3) continue;
    const [w, run] = k.split(",");
    whole.push({
      w,
      run,
      wall: rs.reduce((s, r) => s + num(r.wall_s), 0),
      cpu: rs.reduce((s, r) => s + cpu(r), 0),
      max: Math.max(...rs.map((r) => num(r.wall_s))),
    });
  }
  table(
    "all three packages: serial sum (pnpm -r run test) and slowest package (CI matrix)",
    ["workers", "runs", "serial wall", "slowest package wall", "cpu"],
    [...group(whole, (r) => r.w)].map(([w, rs]) => [
      w,
      rs.length,
      stat(rs.map((r) => r.wall)),
      stat(rs.map((r) => r.max)),
      stat(rs.map((r) => r.cpu)),
    ]),
  );
}

// failures per test across the raw reports
const reportDir = join(data, "reports");
if (existsSync(reportDir)) {
  const fails = new Map();
  const runs = new Map();
  for (const name of readdirSync(reportDir).sort()) {
    const m = /^(.+)-w(.+)-r(\d+)\.json$/.exec(name);
    if (!m) continue;
    const key = `${m[1]},w${m[2]}`;
    runs.set(key, (runs.get(key) ?? 0) + 1);
    const rep = JSON.parse(readFileSync(join(reportDir, name), "utf8"));
    for (const t of rep.testResults) {
      for (const a of t.assertionResults) {
        if (a.status === "failed") {
          const id = `${key} | ${t.name.replace(/^.*\/packages\//, "packages/")} | ${a.fullName}`;
          fails.set(id, (fails.get(id) ?? 0) + 1);
        }
      }
      if (t.status === "failed" && t.assertionResults.length === 0) {
        const id = `${key} | ${t.name.replace(/^.*\/packages\//, "packages/")} | (file failed to run)`;
        fails.set(id, (fails.get(id) ?? 0) + 1);
      }
    }
  }
  console.log("\n## runs per package and workers, and failing tests across them\n");
  for (const [k, n] of [...runs].sort()) console.log(`- ${k}: ${n} reports`);
  console.log(fails.size ? "" : "\nno failing test in any report");
  for (const [id, n] of [...fails].sort()) console.log(`- failed ${n}x: ${id}`);
}

const cats = read("category-times.csv").filter((r) => r.workers === "default");
if (cats.length) {
  table(
    "time per category, default workers (sum over the files of a package; median (min-max) seconds)",
    [
      "package",
      "category",
      "files",
      "tests",
      "runs",
      "sum of file wall times",
      "sum of test durations",
    ],
    [...group(cats, (r) => `${r.package},${r.category}`)].map(([k, rs]) => {
      const [p, c] = k.split(",");
      return [
        p,
        c,
        rs[0].files,
        rs[0].tests,
        rs.length,
        stat(rs.map((r) => num(r.file_wall_s))),
        stat(rs.map((r) => num(r.test_sum_s))),
      ];
    }),
  );
}

const files = read("file-times.csv").filter((r) => r.workers === "default");
if (files.length) {
  const byFile = [...group(files, (r) => r.file)].map(([f, rs]) => ({
    f,
    c: rs[0].category,
    n: rs[0].tests,
    t: rs.map((r) => num(r.file_wall_s)),
  }));
  byFile.sort((a, b) => median(b.t) - median(a.t));
  table(
    "slowest 20 test files, default workers (file wall time, median (min-max) seconds)",
    ["file", "category", "tests", "time"],
    byFile
      .slice(0, 20)
      .map((x) => [x.f.replace("packages/", ""), x.c, x.n, stat(x.t, (v) => v.toFixed(1))]),
  );
  const perPkg = [];
  for (const [p, rs] of group(files, (r) => r.package)) {
    const runsOf = group(rs, (r) => r.run);
    const sums = [...runsOf.values()].map((v) => v.reduce((s, r) => s + num(r.file_wall_s), 0));
    const maxes = [...runsOf.values()].map((v) => Math.max(...v.map((r) => num(r.file_wall_s))));
    perPkg.push([p, stat(sums), stat(maxes)]);
  }
  table(
    "sum of file wall times and longest single file, default workers",
    ["package", "sum of file times", "longest file"],
    perPkg,
  );
}

// slowest single tests, and how one tracked test grows with the worker count
// (--track "<substring of the full test name>"; tests whose describe sets no timeout fail at 5 s)
if (existsSync(reportDir)) {
  const tests = new Map(); // "pkg|workers|file::name" -> durations (ms)
  for (const name of readdirSync(reportDir).sort()) {
    const m = /^(.+)-w(.+)-r(\d+)\.json$/.exec(name);
    if (!m) continue;
    const rep = JSON.parse(readFileSync(join(reportDir, name), "utf8"));
    for (const t of rep.testResults) {
      for (const a of t.assertionResults) {
        const k = `${m[1]}|${m[2]}|${t.name.replace(/^.*\/packages\//, "")}::${a.fullName}`;
        if (!tests.has(k)) tests.set(k, []);
        tests.get(k).push(a.duration ?? 0);
      }
    }
  }
  const rows = [...tests]
    .map(([k, ds]) => {
      const [p, w, n] = k.split("|");
      return { p, w, n, med: median(ds), max: Math.max(...ds) };
    })
    .filter((r) => r.w === "default")
    .sort((a, b) => b.med - a.med);
  table(
    "slowest 12 single tests, default workers (ms)",
    ["package", "test", "median ms", "max ms"],
    rows.slice(0, 12).map((r) => [r.p, r.n.slice(0, 120), r.med.toFixed(0), r.max.toFixed(0)]),
  );
  const track = args.includes("--track") ? args[args.indexOf("--track") + 1] : null;
  if (track) {
    const byW = [...tests]
      .filter(([k]) => k.includes(track))
      .map(([k, ds]) => [
        k.split("|")[0],
        k.split("|")[1],
        ds.length,
        stat(ds, (x) => x.toFixed(0)),
      ]);
    byW.sort(
      (a, b) => (a[1] === "default" ? 7 : Number(a[1])) - (b[1] === "default" ? 7 : Number(b[1])),
    );
    table(
      `duration in ms by workers of tests matching "${track}"`,
      ["package", "workers", "runs", "median (min-max)"],
      byW,
    );
  }
}
