// Classifies recent commits of a branch the way scripts/check-commit.sh does, and gives the share
// of the test suite each commit would run.
//
//   node affected-share.mjs [--end <rev>] [--count 100] [--data <dir>]
//
// For each of the last <count> first-parent commits up to <end> (default HEAD), reads the changed
// files (`git diff --name-only --no-renames <sha>~1 <sha>`), applies the selection rules of
// check-commit.sh (docs only, log, packages with dependents, full) with the scripts/test-inputs.txt
// of that commit, and prices the result with the per-mode wall times of data/check-commit.csv and
// the per-package test times of data/packages.csv (default workers, median).
// Writes <data>/affected-share.csv (one row per commit) and <data>/affected-share-summary.csv.
// Dependents come from the workspace dependencies in packages/*/package.json at <end>.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const data = resolve(opt("data", join(here, "..", "data")));
const end = opt("end", "HEAD");
const count = Number(opt("count", "100"));
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const readCsv = (file) => {
  const [head, ...rows] = readFileSync(file, "utf8").trim().split("\n");
  const cols = head.split(",");
  return rows.map((r) => Object.fromEntries(r.split(",").map((v, i) => [cols[i], v])));
};

// Workspace graph at <end>.
const pkgNames = git("ls-tree", "--name-only", `${end}:packages`).trim().split("\n");
const deps = {};
for (const p of pkgNames) {
  const j = JSON.parse(git("show", `${end}:packages/${p}/package.json`));
  const all = { ...j.dependencies, ...j.devDependencies };
  deps[j.name] = {
    dir: p,
    uses: Object.keys(all).filter((d) => String(all[d]).startsWith("workspace:")),
  };
}
const dirOf = (name) => deps[name]?.dir;
const dependentsOf = (dir) => {
  const out = new Set([dir]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of Object.values(deps)) {
      if (!out.has(d.dir) && d.uses.some((u) => out.has(dirOf(u)))) {
        out.add(d.dir);
        grew = true;
      }
    }
  }
  return out;
};

// Prices. Wall time of check-commit.sh per mode (median over repeats), test wall per package.
const cc = readCsv(join(data, "check-commit.csv"));
const modeWall = (m) => median(cc.filter((r) => r.mode === m).map((r) => Number(r.wall_s)));
const pkgRows = readCsv(join(data, "packages.csv")).filter((r) => r.workers === "default");
const pkgTest = Object.fromEntries(
  pkgNames.map((p) => [
    p,
    median(pkgRows.filter((r) => r.package === p).map((r) => Number(r.wall_s))),
  ]),
);
const suiteTest = pkgNames.reduce((a, p) => a + pkgTest[p], 0);
const wallBySet = (set) => {
  const k = [...set].sort().join("+");
  if (set.size === pkgNames.length) return modeWall("pkg-ledger");
  if (k === "issues") return modeWall("pkg-issues");
  if (k === "adr+issues") return modeWall("pkg-adr");
  return Number.NaN;
};

const readersOf = (lines, file) => {
  const out = [];
  for (const line of lines) {
    const [input, ...readers] = line.trim().split(/\s+/);
    if (!input || input.startsWith("#")) continue;
    if (input.endsWith("/") ? file.startsWith(input) : file === input) out.push(...readers);
  }
  return out;
};

const shas = git("rev-list", "--first-parent", `--max-count=${count}`, end).trim().split("\n");
const rows = [];
for (const sha of shas) {
  const parents = git("rev-list", "--parents", "-n", "1", sha).trim().split(" ").length - 1;
  const date = git("log", "-1", "--format=%cs", sha).trim();
  const subject = git("log", "-1", "--format=%s", sha).trim();
  let full = parents !== 1 ? (parents === 0 ? "root commit" : "merge commit") : "";
  let adrLog = false;
  let issuesLog = false;
  const pkgs = new Set();
  const rootFiles = [];
  let files = [];
  if (!full) {
    files = git("diff", "--name-only", "--no-renames", `${sha}~1`, sha).split("\n").filter(Boolean);
    let inputs = [];
    try {
      inputs = git("show", `${sha}:scripts/test-inputs.txt`).split("\n");
    } catch {}
    for (const f of files) {
      for (const r of readersOf(inputs, f)) pkgs.add(r);
      if (f.startsWith("docs/adr/")) adrLog = true;
      else if (f.startsWith("docs/issues/")) issuesLog = true;
      else if (/^packages\/[^/]+\/src\//.test(f)) pkgs.add(f.split("/")[1]);
      else if (f.endsWith(".md")) continue;
      else if (/^packages\/[^/]+\/.+/.test(f)) pkgs.add(f.split("/")[1]);
      else rootFiles.push(f);
    }
    if (rootFiles.length) full = "workspace-level files";
  }
  let mode;
  let tested = new Set();
  if (full) {
    mode = "full";
    tested = new Set(pkgNames);
  } else if (pkgs.size) {
    mode = "pkg";
    for (const p of pkgs) for (const d of dependentsOf(p)) tested.add(d);
  } else if (adrLog || issuesLog) mode = "log";
  else mode = "docs";
  const testWall = [...tested].reduce((a, p) => a + (pkgTest[p] ?? 0), 0);
  const wall =
    mode === "docs" ? modeWall("docs") : mode === "log" ? modeWall("log") : wallBySet(tested);
  rows.push({
    sha: sha.slice(0, 7),
    date,
    mode,
    packages: [...tested].sort().join(" "),
    files: files.length,
    test_share: (testWall / suiteTest).toFixed(3),
    check_wall_s: wall.toFixed(1),
    subject: `"${subject.replaceAll('"', "'")}"`,
  });
}
const cols = Object.keys(rows[0]);
writeFileSync(
  join(data, "affected-share.csv"),
  `${[cols.join(","), ...rows.map((r) => cols.map((c) => r[c]).join(","))].join("\n")}\n`,
);

// Summary by affected set.
const key = (r) =>
  r.mode === "pkg" || r.mode === "full" ? `${r.mode}: ${r.packages.replaceAll(" ", "+")}` : r.mode;
const groups = new Map();
for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
const total = rows.reduce((a, r) => a + Number(r.check_wall_s), 0);
const sumCols =
  "class,commits,share_of_commits,mean_test_share,check_wall_s_each,share_of_check_time";
const sum = [...groups.entries()]
  .sort((a, b) => b[1].length - a[1].length)
  .map(([k, g]) => {
    const w = g.reduce((a, r) => a + Number(r.check_wall_s), 0);
    const ts = g.reduce((a, r) => a + Number(r.test_share), 0) / g.length;
    return `"${k}",${g.length},${(g.length / rows.length).toFixed(3)},${ts.toFixed(3)},${(w / g.length).toFixed(1)},${(w / total).toFixed(3)}`;
  });
const meanShare = rows.reduce((a, r) => a + Number(r.test_share), 0) / rows.length;
writeFileSync(join(data, "affected-share-summary.csv"), `${[sumCols, ...sum].join("\n")}\n`);
console.log(`${rows.length} commits, ${shas[shas.length - 1].slice(0, 7)}..${shas[0].slice(0, 7)}`);
console.log(
  `mean test share ${meanShare.toFixed(3)}, mean check wall ${(total / rows.length).toFixed(1)} s, sum ${total.toFixed(0)} s`,
);
console.log(sum.join("\n"));
