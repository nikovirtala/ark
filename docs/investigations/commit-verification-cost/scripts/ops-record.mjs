// Appends one JSON line for a checked commit: identity, mode, timing and tests executed.
// Called by exec-check.sh. Tests are read from vitest's default reporter summary in the log
// ("Test Files  3 passed (3)" and "Tests  41 passed (41)"), one pair per package that ran.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const [, , jsonl, cell, seq, log, timing, rc, tIn, tOut, t0] = process.argv;
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const sha = git("rev-parse", "HEAD");
const [wall, user, sys] = timing.split(",").map(Number);
const text = readFileSync(log, "utf8").replace(
  new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"),
  "",
);
let mode = "?";
let pkgs = "";
for (const line of text.split("\n")) {
  const m = line.match(
    /^check-commit: [0-9a-f]+: (full check|packages changed: ([a-z ]+?)(?:,|$)|logs changed|docs only)/,
  );
  if (m) {
    mode = m[1].startsWith("full")
      ? "full"
      : m[1].startsWith("packages")
        ? "pkg"
        : m[1].startsWith("logs")
          ? "log"
          : "docs";
    pkgs = (m[2] ?? "").trim().replace(/ /g, "+");
    break;
  }
}
const tests = {};
for (const line of text.split("\n")) {
  const m = line.match(
    /^(?:(\S+) test:\s+)?\s*(Test Files|Tests)\s+(?:\d+ failed \| )?(\d+) passed(?: \| \d+ skipped)?\s+\((\d+)\)/,
  );
  const f = line.match(/^(?:(\S+) test:\s+)?\s*(Test Files|Tests)\s+(\d+) failed/);
  const hit = m ?? f;
  if (!hit) continue;
  const pkg = hit[1] ?? "pkg";
  tests[pkg] ??= { files: 0, tests: 0 };
  const total = m ? Number(m[4]) : 0;
  if (hit[2] === "Test Files") tests[pkg].files = total;
  else tests[pkg].tests = total;
}
const sum = (k) => Object.values(tests).reduce((a, t) => a + t[k], 0);
const row = {
  cell,
  seq: Number(seq),
  sha: sha.slice(0, 12),
  tree: git("rev-parse", "HEAD^{tree}").slice(0, 12),
  subject: git("log", "-1", "--format=%s"),
  mode,
  pkgs,
  wall_s: wall,
  user_s: user,
  sys_s: sys,
  exit: Number(rc),
  start_s: Number((Number(tIn) - Number(t0)).toFixed(3)),
  end_s: Number((Number(tOut) - Number(t0)).toFixed(3)),
  test_files: sum("files"),
  tests: sum("tests"),
  tests_by_pkg: tests,
};
appendFileSync(jsonl, `${JSON.stringify(row)}\n`);
