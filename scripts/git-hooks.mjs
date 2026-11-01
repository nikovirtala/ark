// Installs or removes ark's own git hooks: adr's and issues' four hooks each and commitlint on
// commit-msg, all in ledger's shared shims (ADR-0011, AGENTS.md "Commit messages"). Usage: pnpm
// git-hooks install|uninstall [--if-built].
// Workspace code is loaded with a dynamic import() only after checking that it is built, so an
// unbuilt checkout gets the "run pnpm install && pnpm build first" message instead of a crash.
// With --if-built the unbuilt checkout is skipped with exit 0 instead of exit 2, so the `prepare`
// script can install the hooks when the workspace is built without failing `pnpm install` on a
// fresh clone whose dist is not yet there (design R8: ark's config never runs the workspace build).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const USAGE = "usage: pnpm git-hooks install|uninstall [--if-built]";
const COMMITLINT = { tool: "commitlint", commands: { "commit-msg": ["--edit", "{args}"] } };

const args = process.argv.slice(2);
const ifBuilt = args.includes("--if-built");
const positional = args.filter((a) => a !== "--if-built");
const action = positional[0];
if (positional.length !== 1 || (action !== "install" && action !== "uninstall")) {
  console.error(USAGE);
  process.exit(2);
}

const root = new URL("..", import.meta.url);
const ledgerEntry = new URL("packages/ledger/dist/index.js", root);
const bins = ["adr", "issues"].map((tool) => ({
  tool,
  bin: new URL(`node_modules/.bin/${tool}`, root),
  dist: new URL(`packages/${tool}/dist/cli.js`, root),
}));
if (!existsSync(ledgerEntry) || bins.some((b) => !existsSync(b.bin) || !existsSync(b.dist))) {
  const tools = bins.map((b) => b.tool).join(" and ");
  if (ifBuilt) {
    console.error(`git-hooks: ${tools} not built yet; skipping hook install (run pnpm build)`);
    process.exit(0);
  }
  console.error(
    `git-hooks: ${tools} must be linked and built; run pnpm install && pnpm build first`,
  );
  process.exit(2);
}

try {
  const { Git, installHooks, uninstallHooks, assertNoHookConflicts } = await import(
    ledgerEntry.href
  );
  const cwd = fileURLToPath(root);
  for (const { bin } of bins) {
    const run = spawnSync(fileURLToPath(bin), ["hooks", action], { stdio: "inherit", cwd });
    if (run.status !== 0) process.exit(run.status ?? 2);
  }
  const git = await Git.open(cwd);
  /** A shim path as the user sees it: repo-relative, as adr prints it. */
  const shown = (path) =>
    path.startsWith(`${git.root}/`) ? path.slice(git.root.length + 1) : path;
  if (action === "install") {
    const r = await installHooks(git, COMMITLINT);
    for (const p of r.written) console.log(`wrote ${shown(p)}`);
    for (const p of r.unchanged) console.log(`unchanged ${shown(p)}`);
    assertNoHookConflicts(r, { tool: COMMITLINT.tool });
  } else {
    const r = await uninstallHooks(git, { tool: COMMITLINT.tool });
    for (const p of r.written) console.log(`removed ${COMMITLINT.tool} from ${shown(p)}`);
  }
} catch (e) {
  console.error(`git-hooks: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
