// Models the options for cutting the cost of verifying every commit of a branch.
// Reads: data/affected-share-400-summary.csv (shares and check time per commit class), data/fit.csv,
//        data/pr-summary.json (branch sizes, force pushes, main movement), data/cache/cache-cells.csv.
// Writes: data/options.csv (one row per option, scenario, operation and N)
//         data/options-summary.csv (one row per option: break-even, dependencies, adoption, session saving)
// Usage: node options-model.mjs [--data DIR]
//
// Every row carries a basis: "measured" (read from a cell), "derived" (arithmetic on measured values) or
// "modelled" (an assumption listed in PARAMS or in the option). Times are seconds of wall time on the
// measured 8-core host unless the column says otherwise.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argData = process.argv.indexOf("--data");
const data = argData > 0 ? process.argv[argData + 1] : join(here, "..", "data");

const csv = (f) => {
  const [h, ...r] = readFileSync(join(data, f), "utf8").trim().split("\n");
  const cols = h.split(",").map((c) => c.replace(/"/g, ""));
  return r.map((l) => {
    const v = l
      .match(/("[^"]*"|[^,]*)(,|$)/g)
      .map((x) => x.replace(/,$/, "").replace(/^"|"$/g, ""));
    return Object.fromEntries(cols.map((c, i) => [c, v[i]]));
  });
};
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) / 2)];
};
const round = (x, d = 1) => (x === "" || x === null || x === undefined ? "" : Number(x.toFixed(d)));

// ---- inputs --------------------------------------------------------------------------------------
const classes = csv("affected-share-400-summary.csv").map((r) => ({
  name: r.class,
  p: Number(r.share_of_commits),
  cost: Number(r.check_wall_s_each),
  tests: Number(r.mean_test_share) > 0,
}));
const prs = JSON.parse(readFileSync(join(data, "pr-summary.json"), "utf8"));
const fit = csv("fit.csv");

// Fixed part: the intercepts of the pk fits (package commits) are within 20 s of zero and a two-point
// fit cannot show more, so the model takes 0 (see findings.md, "Fit"). The kind-weighted fit's 12.9 s is
// not used because its slope terms absorb it. Printed so a reader sees what was read.
const pkIntercepts = fit
  .filter((r) => r.window === "pk" && r.fixed_s !== "")
  .map((r) => Number(r.fixed_s));
const FIXED = Math.abs(median(pkIntercepts)) < 20 ? 0 : median(pkIntercepts);

const PARAMS = {
  fixed_s: FIXED, // derived from fit.csv (pk intercepts), see above
  hit_s: 0.13, // measured: median seconds per cache hit (cache-cells.csv, hit_commits_s / hits)
  miss_overhead_s: 1.0, // measured: 0.9 s per commit at N=10, 1.5 s at N=5 (populate vs uncached)
  hit_machine_s: 0.22, // measured: user+sys per hit, N=5 and 10 repeat runs
  machine_per_wall: 6.77, // derived: mean machine time per wall second over the 400-commit class mix
  test_share_mixed: 0.96, // measured: share of check time in commits that run tests (400 commits)
  test_share_pkg: 0.97, // derived: tests are 97 % of a test-running check (272.3 s of 280.3 s)
  selectable_test_share: 0.13, // derived: unit, git and property tests that import src (upper bound for related/changed)
  workers8_gain: 1 - 262.8 / 272.3, // derived: default 7 workers 272.3 s vs 8 workers 262.8 s (measured)
  incremental_build_gain_s: 2.01 - 0.92, // measured: clean vs warm build (phases.csv)
  p_flake_low: 0.000355, // modelled: random-id flake per test-running commit
  p_flake_bound: 0.057, // derived: 95 % upper bound of 0 failures in 51 local runs
  ci_factor: 1.8, // derived: CI issues job 295 s median vs 164 s here
  ci_full_runner_s: 295 + 169 + 44, // measured: CI test jobs median, issues + adr + ledger
  bisect_range: 100, // modelled: commits between a good and a bad commit
  branches_per_day: prs.work_merged.commits.n / 23, // derived: 78 merged work branches in 23 days (the 27 release-bot branches have N=1 and are not priced)
  force_pushes: prs.work_merged.force_pushes.mean, // measured: 1.14 per work branch
  main_moved_share: prs.work_merged.share_main_moved_while_open, // derived: 0.462
};

const cases = [
  { label: "1", n: 1 },
  { label: "2", n: 2 },
  { label: "5 (work median)", n: prs.expected_cost.work_median.n },
  { label: "10", n: 10 },
  { label: "17 (work p90)", n: prs.expected_cost.work_p90.n },
  { label: "20", n: 20 },
];

const scenarios = {
  mixed: { classes, testShare: PARAMS.test_share_mixed },
  "test-running": {
    classes: classes
      .filter((c) => c.tests)
      .map((c, _, a) => ({ ...c, p: c.p / a.reduce((s, x) => s + x.p, 0) })),
    testShare: PARAMS.test_share_pkg,
  },
};
for (const s of Object.values(scenarios)) {
  s.mean = s.classes.reduce((a, c) => a + c.p * c.cost, 0);
  s.pTests = s.classes.filter((c) => c.tests).reduce((a, c) => a + c.p, 0);
  s.meanTest = s.classes.filter((c) => c.tests).reduce((a, c) => a + c.p * c.cost, 0) / s.pTests;
  s.pNonDocs = s.classes.filter((c) => c.name !== "docs").reduce((a, c) => a + c.p, 0);
}
// Expected maximum of N independent commit costs.
const expectedMax = (s, n) => {
  const cs = [...s.classes].sort((a, b) => a.cost - b.cost);
  let cdf = 0;
  let prev = 0;
  let e = 0;
  for (const c of cs) {
    cdf += c.p;
    const f = Math.min(1, cdf) ** n;
    e += c.cost * (f - prev);
    prev = f;
  }
  return e;
};

// Commits whose result a tree-hash cache cannot reuse, per operation (misses). measured at N=5 and 10
// (cache-cells.csv), generalised: rebase and fixup-first change every tree, fixup-last the last one, reorder
// the swapped pair (2 misses at both N, strict key), reword and a repeat change no tree.
const OPS = ["first", "repeat", "rebase", "reword-mid", "fixup-last", "fixup-first", "reorder"];
const misses = (op, n) =>
  ({
    first: n,
    repeat: 0,
    rebase: n,
    "reword-mid": 0,
    "fixup-last": 1,
    "fixup-first": n,
    reorder: Math.min(2, n),
  })[op];
// Commits whose patch changed (git patch-id), measured in rewrite-counts.csv: the commits a person touched.
const touched = (op) =>
  ({
    first: null,
    repeat: 0,
    rebase: 0,
    "reword-mid": 0,
    "fixup-last": 1,
    "fixup-first": 1,
    reorder: 2,
  })[op];
const valid = (op, n) => !(op === "reorder" && n < 2);

// ---- options ---------------------------------------------------------------------------------------
// Each option: f(s, op, n) -> { wall, fixed, machine, ci, basis, note }. Baseline is the same for all.
const base = (s, _op, n) => ({
  wall: PARAMS.fixed_s + s.mean * n,
  fixed: PARAMS.fixed_s,
  machine: PARAMS.machine_per_wall * s.mean * n,
});
const scaled = (s, _op, n, factor, extraS = 0) => {
  const per = s.mean * factor - extraS;
  return {
    wall: PARAMS.fixed_s + per * n,
    fixed: PARAMS.fixed_s,
    machine: PARAMS.machine_per_wall * per * n,
  };
};
const cacheAfter = (_s, op, n, perMiss) => {
  const m = misses(op, n);
  const h = n - m;
  return {
    wall: PARAMS.fixed_s + h * PARAMS.hit_s + m * (perMiss + PARAMS.miss_overhead_s),
    fixed: PARAMS.fixed_s,
    machine: h * PARAMS.hit_machine_s + m * (PARAMS.machine_per_wall * perMiss + 1.5),
  };
};
const finerFactor = (s) => 1 - PARAMS.selectable_test_share * s.testShare;
const workersFactor = (s) => 1 - PARAMS.workers8_gain * s.testShare;
const incrementalS = (s) => PARAMS.incremental_build_gain_s * s.pNonDocs;
const repeatS = (s, p) => p * s.meanTest * s.pTests; // expected seconds per commit spent repeating a spurious failure

const options = [
  {
    id: "baseline",
    name: "No change: every commit checked on every operation",
    fn: (s, op, n) => ({
      ...base(s, op, n),
      basis: "modelled",
      note: "N x mean per-commit cost of the commit-class mix; first and the rewrite operations cost the same (measured)",
    }),
  },
  {
    id: "tree-cache",
    name: "Tree-hash result cache (strict key: tree, parent tree, selection, tool versions)",
    fn: (s, op, n) => ({
      ...cacheAfter(s, op, n, s.mean),
      basis: "modelled",
      note: "hits 0.13 s and miss overhead 1.0 s measured; miss counts measured at N=5 and 10; per-miss cost is the class mean",
    }),
  },
  {
    id: "finer-selection",
    name: "Finer selection of test files (vitest related or changed), upper bound",
    fn: (s, op, n) => ({
      ...scaled(s, op, n, finerFactor(s)),
      basis: "modelled",
      note: "removes at most 13 % of test time (tests that do not start the built CLI); upper bound, real gain lower",
    }),
  },
  {
    id: "workers-8",
    name: "8 workers instead of 7 (host has 8 cores)",
    fn: (s, op, n) => ({
      ...scaled(s, op, n, workersFactor(s)),
      basis: "derived",
      note: "272.3 s to 262.8 s for the suite (measured), applied to the test share",
    }),
  },
  {
    id: "incremental-build",
    name: "Keep dist/ and tsbuildinfo between commits (incremental tsc and tsdown)",
    fn: (s, op, n) => ({
      ...scaled(s, op, n, 1, incrementalS(s)),
      basis: "derived",
      note: "1.1 s per non-docs commit (clean 2.01 s against warm 0.92 s, measured); gives up the stale-output guarantee",
    }),
  },
  {
    id: "repeatability-low",
    name: "Pin seeds and timeouts (flake rate 0.035 %)",
    fn: (s, op, n) => ({
      ...scaled(s, op, n, 1, repeatS(s, PARAMS.p_flake_low)),
      basis: "modelled",
      note: "expected cost of repeating one spurious failure removed; id flake only",
    }),
  },
  {
    id: "repeatability-bound",
    name: "Pin seeds and timeouts (flake rate 5.7 %, upper bound)",
    fn: (s, op, n) => ({
      ...scaled(s, op, n, 1, repeatS(s, PARAMS.p_flake_bound)),
      basis: "modelled",
      note: "same with the 95 % upper bound of 0 in 51 runs; the data cannot exclude it",
    }),
  },
  {
    id: "verify-touched",
    name: "Verify only the commits whose patch changed (patch-id), tip left to CI",
    fn: (s, op, n) => {
      const t = touched(op);
      const k = t === null ? n : Math.min(t, n);
      return {
        wall: PARAMS.fixed_s + s.mean * k,
        fixed: PARAMS.fixed_s,
        machine: PARAMS.machine_per_wall * s.mean * k,
        basis: "modelled",
        note: "patch-changed counts measured (rewrite-counts.csv); skips commits after a rebase onto moved main",
      };
    },
  },
  {
    id: "ci-matrix",
    name: "CI job per commit (matrix), developer waits for CI",
    fn: (s, _op, n) => ({
      wall: PARAMS.ci_factor * expectedMax(s, n),
      fixed: 0,
      machine: 0,
      ci: PARAMS.ci_factor * s.mean * Math.max(0, n - 1),
      basis: "modelled",
      note: "wall is the slowest commit (expected maximum over N draws) x 1.8 CI factor, no queueing; extra CI runner seconds are N-1 more checks than today's tip run",
    }),
  },
  {
    id: "merge-queue",
    name: "Merge queue (tests the tip on latest main; no per-commit check after main moves)",
    fn: (s, op, n) => {
      const moves = op === "rebase";
      return {
        ...(moves ? { wall: 0, fixed: 0, machine: 0 } : base(s, op, n)),
        ci: moves ? (1 - (1 - s.pTests) ** n) * PARAMS.ci_full_runner_s : 0,
        basis: "modelled",
        note: "only the rebase onto moved main stops being re-verified per commit; the queue adds one tip run (upper bound: all three packages)",
      };
    },
  },
  {
    id: "lazy-bisect",
    name: "Lazy verification: check commits only when bisect visits them",
    fn: () => ({
      wall: 0,
      fixed: 0,
      machine: 0,
      basis: "modelled",
      note: "local cost 0; the deferred cost is in options-summary.csv (break-even bisect sessions per branch)",
    }),
  },
  {
    id: "cache+faster",
    name: "Tree-hash cache + finer selection + 8 workers (upper bound)",
    fn: (s, op, n) => ({
      ...cacheAfter(s, op, n, s.mean * finerFactor(s) * workersFactor(s)),
      basis: "modelled",
      note: "multiplies the two run-time factors, which assumes they are independent",
    }),
  },
];

// ---- rows ------------------------------------------------------------------------------------------
const rows = [];
const header =
  "option,scenario,operation,n_label,n,before_wall_s,after_wall_s,fixed_before_s,fixed_after_s,per_commit_before_s,per_commit_after_s,avoidable_s,saving_s,saving_pct,machine_before_s,machine_after_s,ci_extra_runner_s,basis,note";
const out = [header];
const table = {};
for (const [sname, s] of Object.entries(scenarios)) {
  for (const op of OPS) {
    for (const c of cases) {
      if (!valid(op, c.n)) continue;
      const b = base(s, op, c.n);
      const avoidable = (c.n - misses(op, c.n)) * s.mean;
      for (const o of options) {
        const a = o.fn(s, op, c.n);
        const r = {
          option: o.id,
          scenario: sname,
          operation: op,
          n_label: c.label,
          n: c.n,
          before: b.wall,
          after: a.wall,
          fb: b.fixed,
          fa: a.fixed,
          pcb: (b.wall - b.fixed) / c.n,
          pca: (a.wall - a.fixed) / c.n,
          avoidable,
          saving: b.wall - a.wall,
          pct: b.wall ? (100 * (b.wall - a.wall)) / b.wall : 0,
          mb: b.machine,
          ma: a.machine,
          ci: a.ci ?? 0,
          basis: a.basis,
          note: a.note,
        };
        table[`${o.id}|${sname}|${op}|${c.n}`] = r;
        out.push(
          [
            r.option,
            r.scenario,
            r.operation,
            `"${r.n_label}"`,
            r.n,
            round(r.before),
            round(r.after),
            round(r.fb),
            round(r.fa),
            round(r.pcb, 2),
            round(r.pca, 2),
            round(r.avoidable),
            round(r.saving),
            round(r.pct),
            round(r.mb),
            round(r.ma),
            round(r.ci),
            r.basis,
            `"${r.note}"`,
          ].join(","),
        );
        rows.push(r);
      }
    }
  }
}

// Measured rows: the prototype cache on the old window at N=5 and 10, against the same operation uncached.
const cells = csv("cache/cache-cells.csv");
for (const n of [5, 10]) {
  for (const op of [
    "populate",
    "first",
    "reword-mid",
    "reorder",
    "reorder-loose",
    "reorder-at4",
    "fixup-last",
    "fixup-mid",
    "fixup-first",
    "rebase",
  ]) {
    const cs = cells.filter((r) => Number(r.n) === n && r.op === op);
    if (!cs.length) continue;
    const after = median(cs.map((r) => Number(r.verify_wall_s)));
    const before = cs[0].uncached_wall_s === "" ? "" : Number(cs[0].uncached_wall_s);
    const m = median(cs.map((r) => Number(r.verify_user_s) + Number(r.verify_sys_s)));
    const mb =
      cs[0].uncached_user_s === ""
        ? ""
        : Number(cs[0].uncached_user_s) + Number(cs[0].uncached_sys_s);
    const hits = median(cs.map((r) => Number(r.hits)));
    const miss = median(cs.map((r) => Number(r.misses)));
    out.push(
      [
        "tree-cache-prototype",
        "old-window",
        op === "populate" ? "first (cold cache)" : op,
        `"${n}"`,
        n,
        round(before),
        round(after),
        "",
        "",
        before === "" ? "" : round(before / n, 2),
        round(after / n, 2),
        "",
        before === "" ? "" : round(before - after),
        before === "" ? "" : round((100 * (before - after)) / before),
        mb === "" ? "" : round(mb),
        round(m),
        0,
        "measured",
        `"${cs.length} repeat(s), median; ${hits} hits and ${miss} misses of ${n}; uncached is the median of the grid cells of the same operation"`,
      ].join(","),
    );
  }
}
writeFileSync(join(data, "options.csv"), `${out.join("\n")}\n`);

// ---- summary ---------------------------------------------------------------------------------------
const mixOps = {
  rebase: 0.4,
  "fixup-last": 0.2,
  "reword-mid": 0.2,
  reorder: 0.1,
  "fixup-first": 0.1,
}; // modelled assumption
// Verification policies (modelled). "once": AGENTS.md, one per-commit check before the branch is marked
// ready, so a session is the first verification only. "one-rewrite": one re-verification after a rewrite.
// "every-force-push": every force push is re-verified (1.14 per work branch, which also counts amends).
const policies = { once: 0, "one-rewrite": 1, "every-force-push": PARAMS.force_pushes };
const session = (opt, sname, n, field, rewrites = PARAMS.force_pushes) => {
  const get = (op) => table[`${opt}|${sname}|${op}|${n}`][field];
  let t = get("first");
  for (const [op, w] of Object.entries(mixOps)) t += rewrites * w * get(op);
  return t;
};
const breakEven = (opt, sname, op) => {
  const s = scenarios[sname];
  const o = options.find((x) => x.id === opt);
  for (let n = 1; n <= 60; n++) {
    if (!valid(op, n)) continue;
    const b = base(s, op, n).wall;
    const a = o.fn(s, op, n).wall;
    if (a < b - 1e-9) return n;
  }
  return "never";
};
const adoption = {
  baseline: ["", "", "", "", "", ""],
  "tree-cache": [
    "tree-cache",
    "none (prototype exists)",
    "2 to 4 for the prototype made reliable (shared store, notes, CI cross-check)",
    "0 (optional cross-check job)",
    "script and a cache directory or git notes",
    "none for the author; a stale or wrong entry hides a failure",
  ],
  "finer-selection": [
    "",
    "none",
    "5 to 15 (dependency recording, tests that start the CLI are not visible to it)",
    "0",
    "vitest related, changed or experimental.recordDependencies; selection kept in step with test-inputs.txt",
    "none; a missed test is a silent gap",
  ],
  "workers-8": [
    "",
    "none",
    "0.1",
    "0 (CI has 4 cores and 6 workers)",
    "one flag in check-commit.sh",
    "none; host dependent",
  ],
  "incremental-build": [
    "",
    "none",
    "0.5 to 1",
    "0",
    "change check-commit.sh, drop rm -rf dist",
    "none; stale output can hide a missing export",
  ],
  "repeatability-low": [
    "",
    "none",
    "1 to 3",
    "0",
    "seed and timeout fixes in tests (outside this investigation)",
    "none",
  ],
  "repeatability-bound": ["", "none", "1 to 3", "0", "same", "none"],
  "verify-touched": [
    "",
    "none",
    "1 to 2 (record verified patch-ids)",
    "0",
    "notes or a file of verified patch-ids",
    "people verify only what they touched; main movement is not re-checked locally",
  ],
  "ci-matrix": [
    "",
    "none",
    "1 to 2",
    "large: (N-1) more test runs per push",
    "workflow change",
    "developer waits for CI, not for the local run",
  ],
  "merge-queue": [
    "",
    "none",
    "0.5 to 1",
    "one tip run per merge",
    "repository rule and workflow trigger",
    "queue wait; branch rule change",
  ],
  "lazy-bisect": [
    "",
    "none",
    "1",
    "0",
    "bisect script that runs check-commit.sh",
    "no per-commit assurance when merging; bisect needs every commit buildable",
  ],
  "cache+faster": [
    "tree-cache; finer-selection; workers-8",
    "see parts",
    "sum of the parts",
    "0",
    "see parts",
    "see parts",
  ],
};
// How each option weakens "every commit passes on its own" (see findings.md, "How each option weakens...").
const weakens = {
  "tree-cache":
    "a hit reuses an earlier run for an equal key; eight gaps listed in findings.md; closed by key, refresh runs and tip CI",
  "finer-selection": "a test the selection misses never runs for that commit; silent",
  "workers-8":
    "none by design; the timeout margin of scope.test.ts shrinks (2255 to 2457 ms of 5000 ms), so a flaky failure becomes likelier",
  "incremental-build": "stale dist/ or tsbuildinfo can hide a missing export or a build error",
  "repeatability-low": "none; fewer spurious failures",
  "repeatability-bound": "none; the same change priced at the upper bound, not an expected saving",
  "verify-touched": "untouched commits are not checked on their new base; a rebase checks nothing",
  "ci-matrix": "none for the commit, but the result arrives after a push, not before it",
  "merge-queue":
    "a rebase onto moved main gets a tip check only; commits below the tip are not checked on the new base",
  "lazy-bisect": "no check at merge; a broken commit is found by a later bisect",
  "cache+faster": "the sum of the parts",
};
const sum = [
  "option,name,scenario,policy,break_even_n_first,break_even_n_rebase,break_even_n_reword,session_before_n5_s,session_after_n5_s,session_before_n17_s,session_after_n17_s,payback_days_n5,payback_days_n17,depends_on,ci_spend,effort_person_days,tooling,workflow,weakens_every_commit_passes,basis",
];
for (const [sname] of Object.entries(scenarios)) {
  for (const [pname, rw] of Object.entries(policies)) {
    for (const o of options) {
      if (o.id === "baseline") continue;
      const a = adoption[o.id];
      const s5 = prs.expected_cost.work_median.n;
      const s17 = prs.expected_cost.work_p90.n;
      const b5 = session("baseline", sname, s5, "before", rw);
      const a5 = session(o.id, sname, s5, "after", rw);
      const b17 = session("baseline", sname, s17, "before", rw);
      const a17 = session(o.id, sname, s17, "after", rw);
      const effort = a[2].match(/[\d.]+/g)?.map(Number) ?? [0];
      const eff = effort.length > 1 ? (effort[0] + effort[1]) / 2 : effort[0];
      const payback = (save) =>
        save > 0 && eff ? round((eff * 8 * 3600) / (save * PARAMS.branches_per_day), 1) : "";
      sum.push(
        [
          o.id,
          `"${o.name}"`,
          sname,
          pname,
          breakEven(o.id, sname, "first"),
          breakEven(o.id, sname, "rebase"),
          breakEven(o.id, sname, "reword-mid"),
          round(b5),
          round(a5),
          round(b17),
          round(a17),
          payback(b5 - a5),
          payback(b17 - a17),
          `"${a[0]}"`,
          `"${a[3]}"`,
          `"${a[2]}"`,
          `"${a[4]}"`,
          `"${a[5]}"`,
          `"${weakens[o.id]}"`,
          "modelled",
        ].join(","),
      );
    }
  }
}
// Lazy verification: bisect sessions per branch at which lazy costs as much as eager (modelled).
for (const [sname, s] of Object.entries(scenarios)) {
  const steps = Math.ceil(Math.log2(PARAMS.bisect_range));
  for (const n of [prs.expected_cost.work_median.n, prs.expected_cost.work_p90.n]) {
    const eager = session("baseline", sname, n, "before");
    const bisect = steps * s.meanTest;
    sum.push(
      [
        `lazy-bisect-breakeven`,
        `"bisect sessions per branch at which lazy equals eager, N=${n}, ${steps} probes of ${round(s.meanTest)} s"`,
        sname,
        "every-force-push",
        "",
        "",
        "",
        round(eager),
        round(bisect),
        "",
        "",
        round(eager / bisect, 2),
        "",
        '""',
        '""',
        '""',
        '""',
        '""',
        '""',
        "modelled",
      ].join(","),
    );
  }
}
writeFileSync(join(data, "options-summary.csv"), `${sum.join("\n")}\n`);

console.log(
  `fixed part ${PARAMS.fixed_s} s (pk intercepts ${pkIntercepts.join(", ")}); mixed mean ${scenarios.mixed.mean.toFixed(1)} s, test-running mean ${scenarios["test-running"].mean.toFixed(1)} s`,
);
console.log(
  `wrote ${join(data, "options.csv")} (${out.length - 1} rows) and options-summary.csv (${sum.length - 1} rows)`,
);
