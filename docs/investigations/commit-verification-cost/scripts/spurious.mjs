// Probability that at least one of N commits fails for a reason unrelated to the commit.
//
//   node spurious.mjs [--data <dir>]
//
// Inputs (all in <dir>):
//   packages.csv          package test runs of measure.sh with their exit codes
//   id-zzz-estimate.json  rate of the random-id flake (id-zzz-estimate.mjs)
//   pr-summary.json       CI statistics of analyze-prs.mjs
//   affected-share-400.csv  share of commits that run tests (affected-share.mjs --count 400)
// Writes <dir>/spurious.csv. The model: each test-running commit fails spuriously with probability
// p, independently, and commits that run no tests cannot. P(at least one of N) = 1 - (1 - p)^k with
// k the number of test-running commits among N: k = N (a branch of package commits) or
// k = share * N (a typical branch, expected value, not rounded).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const i = args.indexOf("--data");
const data = resolve(i >= 0 ? args[i + 1] : join(here, "..", "data"));

const csv = (f) => {
  const [h, ...rows] = readFileSync(join(data, f), "utf8").trim().split("\n");
  const cols = h.split(",");
  return rows.map((r) => Object.fromEntries(r.split(",").map((v, j) => [cols[j], v])));
};

// 1. Measured package runs at default workers and at 2 to 8 workers (what CI-like settings cover).
const pk = csv("packages.csv").filter((r) => ["default", "2", "4", "6", "8"].includes(r.workers));
const runs = pk.length;
const failures = pk.filter((r) => r.exit !== "0").length;
// Rule of three generalised: with 0 failures in n runs, the one-sided 95% upper bound is 1 - 0.05^(1/n).
const upper95 = failures === 0 ? 1 - 0.05 ** (1 / runs) : Number.NaN;

// 2. Modelled random-id flake: 2 closed issues in the fixture, each id contains "zzz" at `rate`.
const zzz = JSON.parse(readFileSync(join(data, "id-zzz-estimate.json"), "utf8"));
const pZzz = 2 * zzz.rate;

// 3. CI: reruns of a run that then passed are the only visible sign of a spurious failure; the
// rerun may also have been intentional, so this is an upper bound.
const s = JSON.parse(readFileSync(join(data, "pr-summary.json"), "utf8")).ci_runs;
const pCi = s.rerun_runs_succeeded / s.completed_success_or_failure;

// 4. Share of commits that run tests (400 main commits).
const modes = csv("affected-share-400.csv");
const testShare = modes.filter((r) => r.mode === "pkg" || r.mode === "full").length / modes.length;

const scenarios = [
  ["zzz id flake only (modelled)", pZzz],
  ["1 % per test-running commit (illustrative)", 0.01],
  [`95 % upper bound of ${failures} in ${runs} local runs (derived)`, upper95],
  [
    `CI reruns that passed, ${s.rerun_runs_succeeded} of ${s.completed_success_or_failure} completed runs (upper bound)`,
    pCi,
  ],
];
const ns = [1, 2, 5, 10, 20];
const out = ["scenario,p_per_test_commit,basis,commits_with_tests,N,p_at_least_one"];
for (const [name, p] of scenarios) {
  for (const [basis, k] of [
    ["all N run tests", (n) => n],
    [`typical branch, ${(testShare * 100).toFixed(1)} % run tests`, (n) => testShare * n],
  ]) {
    for (const n of ns) {
      const prob = 1 - (1 - p) ** k(n);
      out.push(
        `"${name}",${p.toPrecision(3)},"${basis}",${k(n).toFixed(2)},${n},${prob.toFixed(5)}`,
      );
    }
  }
}
writeFileSync(join(data, "spurious.csv"), `${out.join("\n")}\n`);
console.log(
  `local runs ${runs}, failures ${failures}, upper95 ${upper95.toFixed(4)}, zzz ${pZzz.toFixed(5)}, ci ${pCi.toFixed(4)}, test share ${testShare.toFixed(3)}`,
);
for (const [name, p] of scenarios) {
  console.log(name, ns.map((n) => `${n}:${(100 * (1 - (1 - p) ** n)).toFixed(2)}%`).join(" "));
}
