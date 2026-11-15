// Reconciles numbers quoted in pull-request-body.md (and findings.md) against the data files.
// Each check reads a value from data/, rounds it as the text does, and compares it with the number
// written in the text. Prints one line per check and exits 1 when any differs.
// Usage: node check-numbers.mjs [--data DIR]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataIdx = process.argv.indexOf("--data");
const data = dataIdx > 0 ? process.argv[dataIdx + 1] : join(here, "..", "data");

const parse = (file) => {
  const lines = readFileSync(join(data, file), "utf8").trim().split("\n");
  const split = (l) =>
    [...l.matchAll(/("([^"]*)"|[^,]*)(,|$)/g)].map((m) => m[2] ?? m[1]).slice(0, -1);
  const head = split(lines[0]);
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v])));
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const json = JSON.parse(readFileSync(join(data, "pr-summary.json"), "utf8"));
const cc = parse("check-commit.csv");
const pk = parse("packages.csv");
const op = parse("options.csv");
const os = parse("options-summary.csv");
const cache = parse("cache/cache-cells.csv");
const sp = parse("spurious.csv");
const cell = (cells, c) => cells.find((r) => r.cell === c);
const mode = (m, col) => median(cc.filter((r) => r.mode === m).map((r) => Number(r[col])));
const mach = (m) =>
  median(cc.filter((r) => r.mode === m).map((r) => Number(r.user_s) + Number(r.sys_s)));
const pkgWall = (p) =>
  median(pk.filter((r) => r.package === p && r.workers === "default").map((r) => Number(r.wall_s)));
const opt = (option, scenario, operation, n, col) =>
  Number(
    op.find(
      (r) =>
        r.option === option &&
        r.scenario === scenario &&
        r.operation === operation &&
        r.n === String(n),
    )[col],
  );
const cw = (c) => Number(cell(cache, c).verify_wall_s);
const spur = (scn, n, k) =>
  Number(
    sp.find(
      (r) =>
        r.scenario.startsWith(scn) &&
        Number(r.N) === n &&
        Math.abs(Number(r.commits_with_tests) - k) < 0.01,
    ).p_at_least_one,
  ) * 100;

const checks = [
  ["docs wall", mode("docs", "wall_s"), 0.6, 1],
  ["log wall", mode("log", "wall_s"), 5.0, 1],
  ["issues wall", mode("pkg-issues", "wall_s") || mode("issues", "wall_s"), 170.7, 1],
  ["adr machine", mach("pkg-adr") || mach("adr"), 1830.0, 1],
  ["adr test wall", pkgWall("adr"), 91.0, 1],
  ["issues test wall", pkgWall("issues"), 164.1, 1],
  ["ledger test wall", pkgWall("ledger"), 17.3, 1],
  ["work branches mean commits", json.work_merged.commits.mean, 8.3, 1],
  ["work branches p90 commits", json.work_merged.commits.p90, 17, 0],
  ["work force push mean", json.work_merged.force_pushes.mean, 1.14, 2],
  ["work force push share %", json.work_merged.share_with_force_push * 100, 67, 0],
  [
    "force pushes over 10 commits",
    json.force_pushes_by_branch_size_work[">10"].mean_force_pushes,
    1.83,
    2,
  ],
  ["mean per commit cost", json.expected_cost.mean_wall_per_commit_s, 78.4, 1],
  ["work median mixed", json.expected_cost.work_median.mixed_mean_s, 392, 0],
  ["work p90 mixed", json.expected_cost.work_p90.mixed_mean_s, 1333, 0],
  ["work p90 all packages", json.expected_cost.work_p90.all_package_commits_s, 4774, 0],
  ["cache reword N=5 before", opt("baseline", "mixed", "first", 5, "after_wall_s"), 392, 0],
  ["cache reword N=5 after", opt("tree-cache", "mixed", "reword-mid", 5, "after_wall_s"), 0.7, 1],
  ["cache reword N=17 after", opt("tree-cache", "mixed", "reword-mid", 17, "after_wall_s"), 2.2, 1],
  ["cache first N=17 after", opt("tree-cache", "mixed", "first", 17, "after_wall_s"), 1349, 0],
  [
    "cache fixup-last N=5 after",
    opt("tree-cache", "mixed", "fixup-last", 5, "after_wall_s"),
    80,
    0,
  ],
  ["cache reorder N=17 after", opt("tree-cache", "mixed", "reorder", 17, "after_wall_s"), 161, 0],
  ["finer N=17 after", opt("finer-selection", "mixed", "first", 17, "after_wall_s"), 1166, 0],
  ["ci-matrix N=17 after", opt("ci-matrix", "mixed", "first", 17, "after_wall_s"), 501, 0],
  [
    "session N=5 before",
    Number(os.find((r) => r.option === "tree-cache" && r.scenario === "mixed").session_before_n5_s),
    839,
    0,
  ],
  [
    "session N=17 after",
    Number(os.find((r) => r.option === "tree-cache" && r.scenario === "mixed").session_after_n17_s),
    2156,
    0,
  ],
  [
    "test-running session N=17 after",
    Number(
      os.find((r) => r.option === "tree-cache" && r.scenario === "test-running")
        .session_after_n17_s,
    ),
    6738,
    0,
  ],
  [
    "payback N=5 days",
    Number(os.find((r) => r.option === "tree-cache" && r.scenario === "mixed").payback_days_n5),
    106,
    0,
  ],
  [
    "payback finer N=5 days",
    Number(
      os.find((r) => r.option === "finer-selection" && r.scenario === "mixed").payback_days_n5,
    ),
    603,
    0,
  ],
  ["cache N=5 first again", cw("cn05-first-r1"), 1.0, 1],
  ["cache N=5 populate", cw("cn05-populate-r0"), 181.9, 1],
  ["cache N=5 rebase", cw("cn05-rebase-r1"), 182.8, 1],
  ["cache N=5 fixup-first", cw("cn05-fixup-first-r1"), 183.0, 1],
  ["cache N=10 rebase", cw("cn10-rebase-r1"), 476.9, 1],
  ["spurious 5.7 % N=5 k=N", spur("95 %", 5, 5), 25.45, 2],
  ["spurious 7.9 % N=20 k=6.1", spur("CI reruns", 20, 6.1), 39.59, 2],
];
let bad = 0;
for (const [name, got, want, dp] of checks) {
  const ok = Number(got.toFixed(dp)) === want;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: data ${got.toFixed(dp + 2)}, text ${want}`);
}
console.log(`${checks.length - bad} of ${checks.length} agree`);
process.exit(bad ? 1 : 0);
