// Sorts test files into categories and sums vitest JSON report times per category.
//
//   node categorize.mjs [--repo <root>] [--data <dir>]
//
// Reads <data>/reports/<package>-w<workers>-r<run>.json (written by measure.sh) and writes
//   <data>/file-categories.csv   package,file,category,fast_check,spawns_process,spawns_node,reason
//   <data>/category-times.csv    package,workers,run,category,files,tests,file_wall_s,test_sum_s
//   <data>/file-times.csv        package,workers,run,file,category,tests,file_wall_s,test_sum_s
//
// Category rule (static, from imports; transitive through relative imports):
//   unit              no fast-check, no child_process in the import chain
//   git               child_process in the chain (temp git repos via ledger/testing, git helpers),
//                     no node child
//   cli               child_process and a node child in the chain (built dist/*.js CLI or MCP server)
//   property          imports fast-check and has no child_process in the chain
//   property+git, property+cli   fast-check as well as the above
// "Spawns a process" includes files whose helpers run git or the built CLI. Files that only import
// the library (@nikovirtala/ledger) are not followed: the library spawns git itself, so every
// test that touches the git-backed log would count. Those tests are in "unit" or "property" and the
// document says so.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const repo = resolve(opt("--repo", process.cwd()));
const data = resolve(
  opt("--data", join(repo, "docs/investigations/commit-verification-cost/data")),
);

const cache = new Map();
function analyse(file) {
  if (cache.has(file)) return cache.get(file);
  cache.set(file, { fc: false, spawn: false, node: false, why: "" }); // cycle guard
  let src = "";
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return cache.get(file);
  }
  const res = { fc: /from "fast-check"/.test(src), spawn: false, node: false, why: "" };
  // runs a node child: the built CLI or an MCP server (process.execPath, dist/*.js, "node")
  if (
    /from "node:child_process"/.test(src) &&
    /process\.execPath|dist\/[\w./-]*\.js|(spawn|execFile)(Sync)?\(\s*"node"/.test(src)
  )
    res.node = true;
  if (/from "node:child_process"/.test(src)) {
    res.spawn = true;
    res.why = "child_process";
  }
  // ledger's testing entry point is a workspace import: follow it, it holds temp-repo and spawn-log
  const imports = [...src.matchAll(/from "(\.[^"]*)"/g)].map((m) => m[1]);
  if (/from "@nikovirtala\/ledger\/testing"/.test(src)) {
    imports.push(join(repo, "packages/ledger/src/testing/index.ts"));
  }
  for (const spec of imports) {
    const base = spec.startsWith("/") ? spec : resolve(dirname(file), spec);
    const cand = [base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")].find(
      (c) => existsSync(c) && c.endsWith(".ts"),
    );
    if (!cand) continue;
    // follow test files and test helpers only; product code that spawns git is not a test choice
    if (!/\.test\.ts$|\/test-support\/|\/testing\//.test(cand)) continue;
    const sub = analyse(cand);
    if (sub.node) res.node = true;
    if (sub.spawn && !res.spawn) {
      res.spawn = true;
      res.why = `via ${relative(repo, cand)}`;
    }
  }
  cache.set(file, res);
  return res;
}
// node child implies spawning (it needs child_process); a file that spawns only git is "git"
const base = (a) => (a.spawn && a.node ? "cli" : a.spawn ? "git" : "unit");
const category = (a) => (a.fc ? (a.spawn ? `property+${base(a)}` : "property") : base(a));

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(join(dir, e.name))
      : e.name.endsWith(".test.ts")
        ? [join(dir, e.name)]
        : [],
  );
}

const fileRows = ["package,file,category,fast_check,spawns_process,spawns_node,reason"];
const catOf = new Map();
for (const p of readdirSync(join(repo, "packages"))) {
  const srcDir = join(repo, "packages", p, "src");
  if (!existsSync(srcDir)) continue;
  for (const f of walk(srcDir).sort()) {
    const a = analyse(f);
    const c = category(a);
    catOf.set(f, c);
    fileRows.push(
      [p, relative(repo, f), c, a.fc, a.spawn, a.node, a.why]
        .map((x) => String(x).replaceAll(",", ";"))
        .join(","),
    );
  }
}
writeFileSync(join(data, "file-categories.csv"), `${fileRows.join("\n")}\n`);

const catRows = ["package,workers,run,category,files,tests,file_wall_s,test_sum_s"];
const fileTimeRows = ["package,workers,run,file,category,tests,file_wall_s,test_sum_s"];
const reportDir = join(data, "reports");
for (const name of existsSync(reportDir) ? readdirSync(reportDir).sort() : []) {
  const m = /^(.+)-w(.+)-r(\d+)\.json$/.exec(name);
  if (!m) continue;
  const [, pkg, workers, run] = m;
  const report = JSON.parse(readFileSync(join(reportDir, name), "utf8"));
  const agg = new Map();
  for (const t of report.testResults) {
    const rel = relative(repo, t.name);
    const cat = catOf.get(t.name) ?? catOf.get(join(repo, rel)) ?? "unit";
    const wall = (t.endTime - t.startTime) / 1000;
    const sum = t.assertionResults.reduce((s, a) => s + (a.duration ?? 0), 0) / 1000;
    const a = agg.get(cat) ?? { files: 0, tests: 0, wall: 0, sum: 0 };
    a.files++;
    a.tests += t.assertionResults.length;
    a.wall += wall;
    a.sum += sum;
    agg.set(cat, a);
    fileTimeRows.push(
      [
        pkg,
        workers,
        run,
        rel,
        cat,
        t.assertionResults.length,
        wall.toFixed(3),
        sum.toFixed(3),
      ].join(","),
    );
  }
  for (const [cat, a] of [...agg].sort()) {
    catRows.push(
      [pkg, workers, run, cat, a.files, a.tests, a.wall.toFixed(3), a.sum.toFixed(3)].join(","),
    );
  }
}
writeFileSync(join(data, "category-times.csv"), `${catRows.join("\n")}\n`);
writeFileSync(join(data, "file-times.csv"), `${fileTimeRows.join("\n")}\n`);
console.log(`categorize: ${fileRows.length - 1} test files, ${catRows.length - 1} category rows`);
