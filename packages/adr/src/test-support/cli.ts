/** Test-only helpers for spawning the built `adr` binary on temp repos (design §9). */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Actor } from "@nikovirtala/ledger";
import { createTempRepo, type TempRepo } from "@nikovirtala/ledger/testing";
import { openDecisionLog } from "../log.js";
import { acceptDecision, proposeDecision, supersedeDecision } from "../write.js";
import { cliEnv } from "./decision-arbs.js";

/** `path`, or an error telling the developer to build first. */
export function requireBuilt(path: string): string {
  if (!existsSync(path)) throw new Error(`${path} is missing; run \`pnpm build\` first`);
  return path;
}

/** `packages/adr/dist/cli.js`, built by `pnpm check` before the tests run. */
export const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

export interface AdrRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `node dist/cli.js …args` in `repo` (or `o.cwd`) with `cliEnv(repo, o.env)`. */
export function runAdr(
  repo: TempRepo,
  args: readonly string[],
  o: { readonly env?: NodeJS.ProcessEnv; readonly cwd?: string } = {},
): AdrRun {
  const r = spawnSync(process.execPath, [requireBuilt(CLI), ...args], {
    cwd: o.cwd ?? repo.root,
    env: cliEnv(repo, o.env),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error !== undefined) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The keys of every `adr-write/v1` document, sorted. */
export const WRITE_KEYS: readonly string[] = Object.freeze([
  "affected",
  "command",
  "commit",
  "decision",
  "findings",
  "format",
  "notes",
  "ok",
  "written",
]);

/** The temp repo's identity as a human actor. */
export const REPO_HUMAN: Actor = Object.freeze({
  kind: "human",
  name: "Ledger Test",
  email: "ledger-test@example.com",
  agent: null,
  on_behalf_of: null,
});

/** Sections that fill every section of the built-in nygard template. */
export const NYGARD_SECTIONS: Readonly<Record<string, string>> = Object.freeze({
  context: "We need a database for orders.",
  decision: "We will use the database.",
  scope: "services/orders",
  consequences: "One more service to run.",
});

/** A temp repo on `main` (or `o.initialBranch`) with one commit; the caller disposes it. */
export async function cliRepo(
  files: Readonly<Record<string, string>> = {},
  o: { readonly initialBranch?: string } = {},
): Promise<TempRepo> {
  return createTempRepo({ files: { "README.md": "readme\n", ...files }, ...o });
}

/** Proposes (and, unless `accept` is false, accepts) a decision through the library; its id. */
export async function seedDecision(
  repo: TempRepo,
  title: string,
  o: { readonly accept?: boolean; readonly commit?: boolean; readonly supersedes?: string[] } = {},
): Promise<string> {
  const log = await openDecisionLog({ cwd: repo.root, gitOptions: { env: repo.env } });
  const commit = o.commit ?? true;
  const proposed = await proposeDecision(
    log,
    {
      title,
      sections: NYGARD_SECTIONS,
      actor: REPO_HUMAN,
      ...(o.supersedes === undefined ? {} : { supersedes: o.supersedes }),
    },
    { commit },
  );
  const id = proposed.decision?.id;
  if (!proposed.ok || id === undefined) throw new Error(`could not propose ${title}`);
  if (o.accept === false) return id;
  const accepted = await acceptDecision(log, { id, actor: REPO_HUMAN }, { commit });
  if (!accepted.ok) throw new Error(`could not accept ${title}`);
  return id;
}

/** Installs a foreign `pre-commit` hook that prints `hook says no` and exits 1; its path. */
export async function failingPreCommit(repo: TempRepo): Promise<string> {
  const path = join(repo.git.gitDir, "hooks", "pre-commit");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n');
  await chmod(path, 0o755);
  return path;
}

/** The manual commit command of a `commit-failed` hint (design 2b D5), from adr's stderr. */
export function hintCommand(stderr: string): string {
  const lines = stderr.split("\n");
  const at = lines.findIndex((l) => / exactly these files with the message adr prepared:$/.test(l));
  const command = at < 0 ? undefined : lines[at + 1];
  if (command === undefined) throw new Error(`no commit command in:\n${stderr}`);
  return command.trim();
}

/** Runs `command` with `sh -c` from `/`, in the repo's hermetic environment. */
export function runShell(repo: TempRepo, command: string): AdrRun {
  const r = spawnSync("sh", ["-c", command], {
    cwd: "/",
    env: cliEnv(repo),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error !== undefined) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Supersedes `id` by `by` through the library, committing. */
export async function seedSupersession(repo: TempRepo, id: string, by: string): Promise<void> {
  const log = await openDecisionLog({ cwd: repo.root, gitOptions: { env: repo.env } });
  const r = await supersedeDecision(log, { id, by, actor: REPO_HUMAN }, { commit: true });
  if (!r.ok) throw new Error(`could not supersede ${id} by ${by}`);
}
