// Summarises the pull request data of collect-prs.sh.
//
//   node analyze-prs.mjs [--data <dir>] [--main <rev>]
//
// Reads <dir>/prs/{pulls,pull-details,runs,jobs,jobs-prior}.jsonl and writes
//   <dir>/pr-branches.csv      one row per closed pull request: number, kind, commits, force pushes,
//                              lifetime, main commits that landed while it was open
//   <dir>/pr-summary.json      distributions (commits per branch, force pushes, main movement) and
//                              CI run and job statistics
//   <dir>/ci-failures.csv      one row per CI run that ended in failure, with whether the same head
//                              sha later passed
// No logins, emails or names are read into the output: numbers, shas and timestamps only.
// <rev> (default origin/main) is the history used to count main commits.
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
const mainRev = opt("main", "origin/main");
const read = (f) =>
  readFileSync(join(data, "prs", f), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const pulls = read("pulls.jsonl");
const details = new Map(read("pull-details.jsonl").map((d) => [d.number, d]));
const runs = read("runs.jsonl");
const jobs = read("jobs.jsonl").filter((j) => j.name);
const prior = read("jobs-prior.jsonl");

const q = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const k = (s.length - 1) * p;
  const lo = Math.floor(k);
  return Math.round((s[lo] + (s[Math.ceil(k)] - s[lo]) * (k - lo)) * 100) / 100;
};
const dist = (xs) => ({
  n: xs.length,
  mean: xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null,
  min: q(xs, 0),
  p25: q(xs, 0.25),
  median: q(xs, 0.5),
  p75: q(xs, 0.75),
  p90: q(xs, 0.9),
  max: q(xs, 1),
});
const git = (...a) => {
  try {
    return execFileSync("git", a, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1 << 28,
    }).trim();
  } catch {
    return null;
  }
};
const secs = (a, b) => (new Date(b) - new Date(a)) / 1000;

// Main commits with their committer times, for the time-window count.
const mainLog = (git("log", "--first-parent", "--format=%ct", mainRev) ?? "")
  .split("\n")
  .filter(Boolean)
  .map(Number);

const rows = [];
for (const p of pulls) {
  const d = details.get(p.number);
  if (!d) continue;
  const kind = /^(changeset-release|release)\b/.test(p.head_ref) ? "release" : "work";
  const merged = p.merged_at != null;
  const forcePushes = d.events.filter((e) => e.event === "head_ref_force_pushed").length;
  // Main commits since the pull request's base: base_sha..merge_commit_sha, minus its own commits.
  let sinceBase = null;
  if (merged && p.merge_commit_sha) {
    const n = git("rev-list", "--count", `${p.base_sha}..${p.merge_commit_sha}`);
    if (n != null) sinceBase = Math.max(0, Number(n) - d.commits);
  }
  // Main commits whose committer time falls between opening and merging (direct pushes and other
  // merged pull requests), minus the pull request's own commits when merged by rebase.
  let whileOpen = null;
  if (merged) {
    const a = new Date(p.created_at) / 1000;
    const b = new Date(p.merged_at) / 1000;
    whileOpen = Math.max(0, mainLog.filter((t) => t > a && t <= b + 5).length - d.commits);
  }
  rows.push({
    number: p.number,
    kind,
    merged: merged ? 1 : 0,
    created_at: p.created_at,
    closed_at: p.closed_at,
    commits: d.commits,
    force_pushes: forcePushes,
    ready_events: d.events.filter((e) => e.event === "ready_for_review").length,
    lifetime_h: merged ? Math.round((secs(p.created_at, p.merged_at) / 3600) * 100) / 100 : "",
    main_since_base: sinceBase ?? "",
    main_while_open: whileOpen ?? "",
    base_force_pushes: d.events.filter((e) => e.event === "base_ref_force_pushed").length,
  });
}
const cols = Object.keys(rows[0]);
writeFileSync(
  join(data, "pr-branches.csv"),
  `${[cols.join(","), ...rows.map((r) => cols.map((c) => r[c]).join(","))].join("\n")}\n`,
);

const merged = rows.filter((r) => r.merged);
const work = merged.filter((r) => r.kind === "work");
const hist = (rs) => {
  const h = {};
  for (const r of rs) {
    const k =
      r.commits === 1
        ? "1"
        : r.commits <= 2
          ? "2"
          : r.commits <= 5
            ? "3-5"
            : r.commits <= 10
              ? "6-10"
              : r.commits <= 20
                ? "11-20"
                : ">20";
    h[k] = (h[k] ?? 0) + 1;
  }
  return h;
};
const stat = (rs) => ({
  commits: dist(rs.map((r) => r.commits)),
  commits_histogram: hist(rs),
  force_pushes: dist(rs.map((r) => r.force_pushes)),
  share_with_force_push: rs.length
    ? Math.round((rs.filter((r) => r.force_pushes > 0).length / rs.length) * 1000) / 1000
    : null,
  force_pushes_total: rs.reduce((a, r) => a + r.force_pushes, 0),
  lifetime_h: dist(rs.filter((r) => r.lifetime_h !== "").map((r) => r.lifetime_h)),
  main_since_base: dist(rs.filter((r) => r.main_since_base !== "").map((r) => r.main_since_base)),
  main_while_open: dist(rs.filter((r) => r.main_while_open !== "").map((r) => r.main_while_open)),
  share_main_moved_while_open: (() => {
    const w = rs.filter((r) => r.main_while_open !== "");
    return w.length
      ? Math.round((w.filter((r) => r.main_while_open > 0).length / w.length) * 1000) / 1000
      : null;
  })(),
});
// Force pushes against N: does a longer branch get rewritten more often?
const bySize = {};
for (const r of work) {
  const k = r.commits <= 2 ? "1-2" : r.commits <= 5 ? "3-5" : r.commits <= 10 ? "6-10" : ">10";
  bySize[k] = [...(bySize[k] ?? []), r.force_pushes];
}
const forceBySize = Object.fromEntries(
  Object.entries(bySize).map(([k, v]) => [
    k,
    {
      prs: v.length,
      mean_force_pushes: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100,
      share_with_force_push: Math.round((v.filter((x) => x > 0).length / v.length) * 1000) / 1000,
    },
  ]),
);

// CI.
const ci = runs.filter((r) => r.name === "CI");
const done = ci.filter((r) => r.conclusion === "success" || r.conclusion === "failure");
const bySha = new Map();
for (const r of ci) bySha.set(r.head_sha, [...(bySha.get(r.head_sha) ?? []), r]);
const failed = ci.filter((r) => r.conclusion === "failure");
const failRows = failed.map((r) => {
  const same = bySha.get(r.head_sha).filter((x) => x.id !== r.id);
  const laterPass = same.some(
    (x) => x.conclusion === "success" && new Date(x.created_at) > new Date(r.created_at),
  );
  const failedJobs = jobs
    .filter((j) => j.run_id === r.id && j.conclusion === "failure")
    .map((j) => j.name.replace(/\s*\(.*$/, ""));
  return {
    run_id: r.id,
    event: r.event,
    created_at: r.created_at,
    run_attempt: r.run_attempt,
    failed_jobs: [...new Set(failedJobs)].join(" "),
    same_sha_later_passed: laterPass ? 1 : 0,
    passed_on_rerun_attempt: r.run_attempt > 1 && r.conclusion === "success" ? 1 : 0,
  };
});
const fcols = Object.keys(failRows[0]);
writeFileSync(
  join(data, "ci-failures.csv"),
  `${[fcols.join(","), ...failRows.map((r) => fcols.map((c) => r[c]).join(","))].join("\n")}\n`,
);

const jobStat = {};
for (const j of jobs.filter((j) => j.conclusion && j.started_at && j.completed_at)) {
  const name = j.name.replace(/\s*\(.*$/, "");
  jobStat[name] ??= { runs: 0, failed: 0, cancelled: 0, skipped: 0, secs: [] };
  const s = jobStat[name];
  s.runs++;
  if (j.conclusion === "failure") s.failed++;
  if (j.conclusion === "cancelled") s.cancelled++;
  if (j.conclusion === "skipped") s.skipped++;
  if (j.conclusion === "success") s.secs.push(secs(j.started_at, j.completed_at));
}
const jobSummary = Object.fromEntries(
  Object.entries(jobStat).map(([k, v]) => [
    k,
    {
      runs: v.runs,
      failed: v.failed,
      cancelled: v.cancelled,
      skipped: v.skipped,
      success_seconds: dist(v.secs),
    },
  ]),
);
// Test matrix jobs by package (name "test (adr, ...)").
const testJobs = {};
for (const j of jobs.filter(
  (j) => j.name.startsWith("test (") && j.conclusion && j.started_at && j.completed_at,
)) {
  const pkg = j.name.match(/^test \(([^,)]+)/)[1];
  testJobs[pkg] ??= { runs: 0, failed: 0, secs: [] };
  const s = testJobs[pkg];
  if (j.conclusion === "success" || j.conclusion === "failure") s.runs++;
  if (j.conclusion === "failure") s.failed++;
  if (j.conclusion === "success") s.secs.push(secs(j.started_at, j.completed_at));
}
const testSummary = Object.fromEntries(
  Object.entries(testJobs).map(([k, v]) => [
    k,
    { completed: v.runs, failed: v.failed, success_seconds: dist(v.secs) },
  ]),
);

const countBy = (xs) => {
  const o = {};
  for (const x of xs) o[x] = (o[x] ?? 0) + 1;
  return o;
};
const prFailed = failRows.filter((r) => r.event === "pull_request");
const priorFailed = prior.filter((j) => j.conclusion === "failure");
// Expected cost of one per-commit verification of a branch of N commits (modelled): N times the mean
// check wall time of 400 main commits (affected-share-400.csv, each priced by data/check-commit.csv),
// the same with only package-testing commits at 280.8 s (all packages, the dearest mode), and the
// kind-weighted fit of findings.md (12.9 + 6.6 N + 173.2 x package commits, share of package commits
// from the same 400 commits).
const shareRows = readFileSync(join(data, "affected-share-400.csv"), "utf8")
  .trim()
  .split("\n")
  .slice(1);
const walls = shareRows.map((l) => Number(l.split(",")[6]));
const meanWall = walls.reduce((a, b) => a + b, 0) / walls.length;
const testShare =
  shareRows.filter((l) => /^[^,]*,[^,]*,(pkg|full),/.test(l)).length / shareRows.length;
const costFor = (n) => ({
  n,
  mixed_mean_s: Math.round(meanWall * n),
  fit_s: Math.round(12.9 + 6.6 * n + 173.2 * testShare * n),
  all_package_commits_s: Math.round(280.8 * n),
  log_commits_only_s: Math.round(5 * n),
});
const workN = stat(work).commits;
const allN = stat(merged).commits;
const expectedCost = {
  mean_wall_per_commit_s: Math.round(meanWall * 10) / 10,
  test_running_share: Math.round(testShare * 1000) / 1000,
  work_median: costFor(workN.median),
  work_p90: costFor(Math.round(workN.p90)),
  all_median: costFor(allN.median),
  all_p90: costFor(Math.round(allN.p90)),
};
const summary = {
  expected_cost: expectedCost,
  collected_pull_requests: rows.length,
  merged: merged.length,
  closed_unmerged: rows.length - merged.length,
  release_pull_requests_merged: merged.filter((r) => r.kind === "release").length,
  all_merged: stat(merged),
  work_merged: stat(work),
  work_merged_more_than_one_commit: stat(work.filter((r) => r.commits > 1)),
  force_pushes_by_branch_size_work: forceBySize,
  ci_runs: {
    total_ci: ci.length,
    by_conclusion: Object.fromEntries(
      ["success", "failure", "cancelled", "action_required"].map((c) => [
        c,
        ci.filter((r) => r.conclusion === c).length,
      ]),
    ),
    by_event: Object.fromEntries(
      [...new Set(ci.map((r) => r.event))].map((e) => [e, ci.filter((r) => r.event === e).length]),
    ),
    completed_success_or_failure: done.length,
    failure_share_of_completed: Math.round((failed.length / done.length) * 1000) / 1000,
    rerun_runs_attempt_gt_1: ci.filter((r) => r.run_attempt > 1).length,
    rerun_runs_succeeded: ci.filter((r) => r.run_attempt > 1 && r.conclusion === "success").length,
    failed_runs: failed.length,
    failed_runs_same_sha_later_passed: failRows.filter((r) => r.same_sha_later_passed).length,
    failed_pull_request_runs: prFailed.length,
    failed_pull_request_runs_same_sha_later_passed: prFailed.filter((r) => r.same_sha_later_passed)
      .length,
    failed_runs_with_failed_test_job: failRows.filter((r) => /\btest\b/.test(r.failed_jobs)).length,
    run_seconds_success: dist(
      ci
        .filter((r) => r.conclusion === "success" && r.run_started_at)
        .map((r) => secs(r.run_started_at, r.updated_at)),
    ),
    jobs_without_data_runs: read("jobs.jsonl").filter((j) => !j.name).length,
    prior_attempt_job_rows: prior.length,
    prior_attempt_failed_jobs: countBy(priorFailed.map((j) => j.name.replace(/\s*\(.*$/, ""))),
  },
  jobs: jobSummary,
  test_jobs_by_package: testSummary,
};
writeFileSync(join(data, "pr-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      merged: summary.merged,
      work: summary.work_merged.commits,
      force: summary.work_merged.share_with_force_push,
      ci: summary.ci_runs,
    },
    null,
    1,
  ),
);
