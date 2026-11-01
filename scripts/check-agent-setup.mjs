// Enforces R9 (docs/03-setup-v1.md): running the shared init on ark reproduces ark's committed
// agent setup with no diff. It copies the committed setup inputs into a throwaway git repo, runs
// the built `adr init --setup` and `issues init --setup`, and fails if any written file (including
// ark-setup.lock) differs from what the repository ships. Run by `pnpm lint`-adjacent CI and
// locally: `node scripts/check-agent-setup.mjs`. Needs `pnpm build` first (it spawns dist/cli.js).
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
  ".claude/skills/adr/SKILL.md",
  ".claude/skills/issues/SKILL.md",
  ".kiro/skills/adr/SKILL.md",
  ".kiro/skills/issues/SKILL.md",
  "AGENTS.md",
  "package.json",
  "ark-setup.lock",
];

const git = (cwd, args) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");

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
    const base = git(root, ["rev-list", "-1", "HEAD", "--", ".mcp.json"]).trim();
    for (const f of ["AGENTS.md", "package.json"]) {
      const before = execFileSync("git", ["show", `${base}^:${f}`], { cwd: root });
      await (await import("node:fs/promises")).writeFile(join(dir, f), before);
    }
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

    const diffs = [];
    for (const f of SETUP_FILES) {
      const want = execFileSync("git", ["show", `HEAD:${f}`], { cwd: root }).toString("utf8");
      const got = await readFile(join(dir, f), "utf8").catch(() => null);
      if (got !== want) diffs.push(f);
    }
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
