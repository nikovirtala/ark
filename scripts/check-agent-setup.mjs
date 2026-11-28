// Enforces R9 (docs/03-setup-v1.md): running the shared init on ark reproduces ark's committed
// agent setup with no diff. It copies the committed setup inputs into a throwaway git repo, runs
// the built `adr init --setup` and `issues init --setup`, and fails if any written file (including
// ark-setup.lock) differs from what the repository ships, in its bytes or in its mode: a hook
// script that isn't 100755 never runs (?77). Run by `pnpm lint`-adjacent CI and locally:
// `node scripts/check-agent-setup.mjs`. Needs `pnpm build` first (it spawns dist/cli.js).
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const ADR = join(root, "packages/adr/dist/cli.js");
const ISSUES = join(root, "packages/issues/dist/cli.js");

// The files init writes that must match the committed fixture, byte for byte.
const SETUP_FILES = [
  ".mcp.json",
  ".claude/settings.json",
  ".claude/hooks/session-start.sh",
  ".claude/hooks/before-edit.sh",
  ".kiro/settings/mcp.json",
  ".kiro/hooks/session-start.kiro.hook.json",
  ".kiro/hooks/before-edit.kiro.hook.json",
  ".kiro/hooks/session-start.sh",
  ".kiro/hooks/before-edit.sh",
  ".kiro/hooks/protect-logs.kiro.hook.json",
  ".kiro/hooks/protect-logs.sh",
  ".claude/skills/adr/SKILL.md",
  ".claude/skills/issues/SKILL.md",
  ".kiro/skills/adr/SKILL.md",
  ".kiro/skills/issues/SKILL.md",
  "AGENTS.md",
  "package.json",
  ".gitattributes",
  "ark-setup.lock",
];

/**
 * The files whose committed form differs from what init wrote. `want` and `got` map each file to
 * `{ text, mode }`, `got` being `null` for a file init did not write; `mode` is the git mode
 * (`100644` or `100755`). Content is compared first; a file with the same bytes but another mode
 * is reported too, since a hook script without its execute bit never runs.
 */
export function diffSetup(want, got) {
  const diffs = [];
  for (const [file, w] of Object.entries(want)) {
    const g = got[file] ?? null;
    if (g === null || g.text !== w.text) diffs.push(file);
    else if (g.mode !== w.mode) diffs.push(`${file} (mode ${g.mode}, committed ${w.mode})`);
  }
  return diffs;
}

/** The text of AGENTS.md without the pointer lines that `adr init` and `issues init` append. */
export function withoutPointers(text) {
  const kept = text
    .split("\n")
    .filter(
      (l) =>
        !l.startsWith("Architecture decisions in this repository are managed by adr:") &&
        !l.startsWith("Issues in this repository are tracked with issues:"),
    );
  return `${kept.join("\n").trimEnd()}\n`;
}

const git = (cwd, args) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");

/** The git mode of the first entry of a `ls-tree` or `ls-files -s` run, or `null` when untracked. */
function gitMode(cwd, args) {
  const out = git(cwd, args).trim();
  return out === "" ? null : out.split(/\s+/)[0];
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "ark-r9-"));
  try {
    // Export the committed tree, then strip everything init writes so it writes it fresh.
    const tar = execFileSync("git", ["archive", "HEAD"], { cwd: root, maxBuffer: 1 << 28 });
    execFileSync("tar", ["-x", "-C", dir], { input: tar });
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "r9@example.com"]);
    git(dir, ["config", "user.name", "R9"]);
    // Pre-setup AGENTS.md and package.json, so the pointer lines and prepare are written fresh.
    // AGENTS.md is the committed one without the pointer lines init appends, so editing its text
    // doesn't fail this check; package.json is the one before the last commit that touched .mcp.json.
    const base = git(root, ["rev-list", "-1", "HEAD", "--", ".mcp.json"]).trim();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "AGENTS.md"), withoutPointers(git(root, ["show", "HEAD:AGENTS.md"])));
    await writeFile(
      join(dir, "package.json"),
      execFileSync("git", ["show", `${base}^:package.json`], { cwd: root }),
    );
    for (const f of SETUP_FILES) {
      if (f === "AGENTS.md" || f === "package.json" || f === "ark-setup.lock") continue;
      await rm(join(dir, f), { force: true });
    }
    await rm(join(dir, ".claude/skills"), { recursive: true, force: true });
    await rm(join(dir, ".kiro/skills"), { recursive: true, force: true });
    await rm(join(dir, "ark-setup.lock"), { force: true });
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "base"]);

    execFileSync("node", [ADR, "init", "--setup", "--no-commit"], { cwd: dir, stdio: "ignore" });
    execFileSync("node", [ISSUES, "init", "--setup", "--no-commit"], { cwd: dir, stdio: "ignore" });

    const want = {};
    const got = {};
    for (const f of SETUP_FILES) {
      want[f] = {
        text: execFileSync("git", ["show", `HEAD:${f}`], { cwd: root }).toString("utf8"),
        mode: gitMode(root, ["ls-tree", "HEAD", "--", f]),
      };
      const text = await readFile(join(dir, f), "utf8").catch(() => null);
      // The mode init staged, and the file system's: both must agree with the committed one.
      const staged = gitMode(dir, ["ls-files", "-s", "--", f]);
      const onDisk = await stat(join(dir, f)).then(
        (s) => ((s.mode & 0o111) !== 0 ? "100755" : "100644"),
        () => null,
      );
      got[f] =
        text === null
          ? null
          : { text, mode: staged === onDisk || staged === null ? onDisk : `${staged}/${onDisk}` };
    }
    const diffs = diffSetup(want, got);
    if (diffs.length > 0) {
      console.error(
        `R9 failed: init does not reproduce the committed setup for:\n  ${diffs.join("\n  ")}`,
      );
      process.exit(1);
    }
    console.log(`R9 OK: init reproduces ark's committed setup (${SETUP_FILES.length} files).`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
