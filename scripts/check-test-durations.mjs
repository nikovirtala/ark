// Reports test files that hold up their package's test run. Usage:
//
//   node scripts/check-test-durations.mjs [--workers <n>] [--min <seconds>] [<report.json>…]
//
// Rule: a test file may take at most its package's summed file time divided by the worker count.
// vitest runs a file's tests one after another in one worker, so a longer file is the last to
// finish however the other files are scheduled. Both sides scale with machine speed, so the rule
// gives the same answer on a laptop and in CI. Files under --min seconds (default 10) always pass,
// so small suites don't fail on timing noise.
//
// Each <report.json> is one package's vitest JSON report (`vitest run --reporter=json
// --outputFile=<report.json>`). Without reports, the script runs every package's suite in turn, as
// `pnpm test` does, with --workers workers. --workers defaults to vitest's own default for `run`:
// os.availableParallelism() - 1.
//
// Exit codes: 0 every file passes, 1 a file breaks the rule, 2 a usage or run error.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function usage(message) {
  console.error(`check-test-durations: ${message}`);
  console.error(
    "usage: node scripts/check-test-durations.mjs [--workers <n>] [--min <seconds>] [<report.json>…]",
  );
  process.exit(2);
}

let workers = Math.max(availableParallelism() - 1, 1);
let min = 10;
const reports = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--workers" || a === "--min") {
    const v = Number(args[++i]);
    if (!Number.isFinite(v) || v <= 0 || (a === "--workers" && !Number.isInteger(v))) {
      usage(`${a} needs a positive ${a === "--workers" ? "integer" : "number"}`);
    }
    if (a === "--workers") workers = v;
    else min = v;
  } else if (a.startsWith("-")) {
    usage(`unknown option ${a}`);
  } else {
    reports.push(a);
  }
}

let scratch = null;
if (reports.length === 0) {
  scratch = mkdtempSync(join(tmpdir(), "ark-test-durations-"));
  const packages = readdirSync(join(root, "packages")).filter((d) => {
    const manifest = join(root, "packages", d, "package.json");
    return existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).scripts?.test;
  });
  for (const p of packages) {
    const report = join(scratch, `${p}.json`);
    console.error(`check-test-durations: running the tests of ${p} with ${workers} workers`);
    const r = spawnSync(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        `--maxWorkers=${workers}`,
        "--reporter=dot",
        "--reporter=json",
        `--outputFile.json=${report}`,
      ],
      { cwd: join(root, "packages", p), stdio: ["ignore", "inherit", "inherit"] },
    );
    if (r.error !== undefined || !existsSync(report)) {
      console.error(`check-test-durations: the tests of ${p} wrote no report`);
      process.exit(2);
    }
    reports.push(report);
  }
}

let broken = 0;
for (const report of reports) {
  let json;
  try {
    json = JSON.parse(readFileSync(report, "utf8"));
  } catch (e) {
    console.error(`check-test-durations: can't read ${report}: ${e.message}`);
    process.exit(2);
  }
  const files = (json.testResults ?? []).map((f) => ({
    name: relative(root, f.name),
    seconds: (f.endTime - f.startTime) / 1000,
  }));
  if (files.length === 0) continue;
  const total = files.reduce((sum, f) => sum + f.seconds, 0);
  const share = total / workers;
  const longest = Math.max(...files.map((f) => f.seconds));
  const pkg = files[0].name.split("/").slice(0, 2).join("/");
  console.log(
    `${pkg}: ${files.length} files, ${total.toFixed(0)}s in total, share ${share.toFixed(0)}s at ${workers} workers, longest ${longest.toFixed(0)}s`,
  );
  for (const f of files.sort((a, b) => b.seconds - a.seconds)) {
    if (f.seconds <= share || f.seconds < min) continue;
    broken++;
    console.log(`  ${f.name}: ${f.seconds.toFixed(0)}s is over the ${share.toFixed(0)}s share`);
  }
}
if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
process.exit(broken > 0 ? 1 : 0);
