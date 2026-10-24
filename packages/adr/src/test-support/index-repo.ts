/** Test-only helpers for logs with a committed `index.md` (design 2b §4.5). */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Git, indexReader, refReader, type TreeReader, worktreeReader } from "@nikovirtala/ledger";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { DEFAULT_ADR_CONFIG } from "../config.js";
import { adrKind } from "../kind.js";
import { renderDecisionIndex } from "../log-index.js";
import { cliEnv } from "./decision-arbs.js";

const run = promisify(execFile);

/** `adr.toml` turning the committed index on. */
export const INDEX_CONFIG = '[log]\nindex = "committed"\n';

/** The default log's index path. */
export const INDEX = "docs/adr/index.md";

/** The bytes `adr index` would write for `which` tree of `git`'s repo (`HEAD` builds on HEAD). */
export async function freshIndex(
  git: Git,
  which: "HEAD" | "worktree" | "index",
  root = "docs/adr",
): Promise<string | null> {
  const head = await git.resolveCommit("HEAD");
  let tree: TreeReader;
  if (which === "worktree") tree = worktreeReader(git);
  else if (which === "index") tree = await indexReader(git);
  else if (head === null) throw new Error("HEAD is unborn");
  else tree = await refReader(git, head);
  return renderDecisionIndex(git, {
    layout: adrKind.layoutAt(root),
    adr: DEFAULT_ADR_CONFIG,
    tree,
    history: head,
  });
}

/** The work-tree, staged and HEAD copies of `path` (`null` where absent). */
export async function indexCopies(
  r: TempRepo,
  path = INDEX,
): Promise<{ worktree: string | null; staged: string | null; head: string | null }> {
  const text = (b: Uint8Array | null) => (b === null ? null : Buffer.from(b).toString("utf8"));
  const head = await r.git.resolveCommit("HEAD");
  return {
    worktree: await readFile(join(r.root, path), "utf8").catch(() => null),
    staged: text(await (await indexReader(r.git)).read(path)),
    head: head === null ? null : text(await (await refReader(r.git, head)).read(path)),
  };
}

/** A `git clone --depth 1` of `r` in a new temp directory; the caller disposes it. */
export async function shallowClone(
  r: TempRepo,
): Promise<{ root: string; git: Git; dispose: () => Promise<void> }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "adr-shallow-")));
  const root = join(dir, "clone");
  const env = cliEnv(r) as Record<string, string>;
  await run("git", ["clone", "-q", "--depth", "1", `file://${r.root}`, root], { env });
  return {
    root,
    git: await Git.open(root, { env: r.env }),
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}
