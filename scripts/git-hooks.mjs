// Installs or removes ark's own git hooks: adr's four hooks and commitlint on commit-msg, all in
// ledger's shared shims (AGENTS.md "Commit messages"). Usage: pnpm git-hooks install|uninstall.
// Workspace code is loaded with a dynamic import() only after checking that it is built, so an
// unbuilt checkout gets the "run pnpm install && pnpm build first" message instead of a crash.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const USAGE = "usage: pnpm git-hooks install|uninstall";
const COMMITLINT = { tool: "commitlint", commands: { "commit-msg": ["--edit", "{args}"] } };

const action = process.argv[2];
if (process.argv.length !== 3 || (action !== "install" && action !== "uninstall")) {
  console.error(USAGE);
  process.exit(2);
}

const root = new URL("..", import.meta.url);
const ledgerEntry = new URL("packages/ledger/dist/index.js", root);
const adrBin = new URL("node_modules/.bin/adr", root);
if (!existsSync(ledgerEntry) || !existsSync(adrBin)) {
  console.error("git-hooks: run pnpm install && pnpm build first");
  process.exit(2);
}

try {
  const { Git, installHooks, uninstallHooks, assertNoHookConflicts } = await import(
    ledgerEntry.href
  );
  const cwd = fileURLToPath(root);
  const adr = spawnSync(fileURLToPath(adrBin), ["hooks", action], { stdio: "inherit", cwd });
  if (adr.status !== 0) process.exit(adr.status ?? 2);
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
