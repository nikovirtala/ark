/** Test-only helpers for spawning the built `issues` binary on temp repos. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Actor } from "@nikovirtala/ledger";
import { createTempRepo, type TempRepo } from "@nikovirtala/ledger/testing";
import { openIssueLog } from "../log.js";
import type { OpenInput } from "../plan.js";
import { openIssue } from "../write.js";

/** `path`, or an error telling the developer to build first. */
export function requireBuilt(path: string): string {
  if (!existsSync(path)) throw new Error(`${path} is missing; run \`pnpm build\` first`);
  return path;
}

/** `packages/issues/dist/cli.js`, built by `pnpm build` before the tests run. */
export const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

/** The workspace's `packages/adr/dist/cli.js`, for tests where both tools' hooks run. */
export const ADR_CLI = fileURLToPath(new URL("../../../adr/dist/cli.js", import.meta.url));

export interface IssuesRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The environment to spawn a tool on `repo` with: the repo's hermetic git environment, and no
 * agent, editor or on-behalf-of variables unless `testEnv` sets them.
 */
export function cliEnv(
  repo: { readonly env: NodeJS.ProcessEnv },
  testEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {
    ...process.env,
    ...repo.env,
    ARK_AGENT: undefined,
    ARK_ON_BEHALF_OF: undefined,
    VISUAL: undefined,
    EDITOR: undefined,
    ...testEnv,
  };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
  return merged;
}

/** Runs `node dist/cli.js …args` in `repo` (or `o.cwd`) with `cliEnv(repo, o.env)`. */
export function runIssues(
  repo: TempRepo,
  args: readonly string[],
  o: { readonly env?: NodeJS.ProcessEnv; readonly cwd?: string; readonly cli?: string } = {},
): IssuesRun {
  const r = spawnSync(process.execPath, [requireBuilt(o.cli ?? CLI), ...args], {
    cwd: o.cwd ?? repo.root,
    env: cliEnv(repo, o.env),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error !== undefined) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** `runIssues` with `--json`, parsing stdout. */
export function runJson<T = Record<string, unknown>>(
  repo: TempRepo,
  args: readonly string[],
  o: { readonly env?: NodeJS.ProcessEnv; readonly cwd?: string } = {},
): IssuesRun & { readonly json: T } {
  const r = runIssues(repo, [...args, "--json"], o);
  let json: T;
  try {
    json = JSON.parse(r.stdout) as T;
  } catch {
    throw new Error(`not JSON (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
  }
  return { ...r, json };
}

/** The keys of every `issues-write/v1` document, sorted. */
export const WRITE_KEYS: readonly string[] = Object.freeze([
  "affected",
  "command",
  "commit",
  "findings",
  "format",
  "issue",
  "notes",
  "ok",
  "written",
]);

/** A temp repo on `main` with one commit; the caller disposes it. */
export async function cliRepo(files: Readonly<Record<string, string>> = {}): Promise<TempRepo> {
  return createTempRepo({ files: { "README.md": "readme\n", ...files } });
}

/** `--section` flags that fill the built-in task template. */
export const TASK_FLAGS: readonly string[] = Object.freeze([
  "--section",
  "goal=Do the thing.",
  "--section",
  "done=The thing is done.",
]);

/** `issues new <title> --commit` with the task sections; the new issue's id. */
export function newIssue(repo: TempRepo, title: string, extra: readonly string[] = []): string {
  const r = runJson<{ ok: boolean; issue: { id: string } | null }>(repo, [
    "new",
    title,
    ...TASK_FLAGS,
    ...extra,
    "--commit",
  ]);
  if (r.status !== 0 || r.json.issue === null)
    throw new Error(`new failed: ${r.stdout}${r.stderr}`);
  return r.json.issue.id;
}

/** The temp repo's identity as a human actor. */
export const REPO_HUMAN: Actor = Object.freeze({
  kind: "human",
  name: "Ledger Test",
  email: "ledger-test@example.com",
  agent: null,
  on_behalf_of: null,
});

/** Opens an issue through the library with the task sections, committing; its id. */
export async function seedIssue(
  repo: TempRepo,
  title: string,
  o: Partial<Omit<OpenInput, "title" | "actor">> = {},
): Promise<string> {
  const log = await openIssueLog({ cwd: repo.root, gitOptions: { env: repo.env } });
  const doc = await openIssue(
    log,
    {
      title,
      sections: { goal: "Do the thing.", done: "The thing is done." },
      actor: REPO_HUMAN,
      ...o,
    },
    { commit: true },
  );
  if (!doc.ok || doc.issue === null) throw new Error(`can't open ${title}`);
  return doc.issue.id;
}

/** Writes `<dir>/node_modules/.bin/issues` and `adr`, so installed shims find the built tools. */
export async function linkBins(dir: string): Promise<void> {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  for (const [name, cli] of [
    ["issues", CLI],
    ["adr", ADR_CLI],
  ] as const) {
    const bin = join(dir, "node_modules", ".bin", name);
    await mkdir(dirname(bin), { recursive: true });
    await writeFile(bin, `#!/bin/sh\nexec ${q(process.execPath)} ${q(requireBuilt(cli))} "$@"\n`);
    await chmod(bin, 0o755);
  }
}

/** A `cliRepo` that ignores `node_modules` (committed), with `linkBins`, for hook tests. */
export async function hooksRepo(files: Readonly<Record<string, string>> = {}): Promise<TempRepo> {
  const r = await cliRepo({ ".gitignore": "node_modules/\n", ...files });
  await linkBins(r.root);
  return r;
}

/** Runs git like a user would, hooks included, in `repo` with `cliEnv`. */
export function runGit(
  repo: TempRepo,
  args: readonly string[],
  o: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): IssuesRun {
  const r = spawnSync("git", args, {
    cwd: o.cwd ?? repo.root,
    env: cliEnv(repo, o.env),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error !== undefined) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Runs the built adr binary in `repo` with `cliEnv`. */
export function runAdrCli(
  repo: TempRepo,
  args: readonly string[],
  o: { readonly env?: NodeJS.ProcessEnv } = {},
): IssuesRun {
  return runIssues(repo, args, { ...o, cli: ADR_CLI });
}
