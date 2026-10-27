import { access, constants } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  assertNoHookConflicts,
  classifyPath,
  exitCode,
  type Finding,
  type Git,
  type HookInstallResult,
  type HookManager,
  type HookName,
  holdsText,
  hookSnippet,
  installHooks,
  parseEventFileName,
  resolveAttribution,
  type Severity,
  stagedRenames,
  type Trailer,
  UsageError,
  uninstallHooks,
  writeIndexFile,
} from "@nikovirtala/ledger";
import { adrKind } from "./kind.js";
import type { DecisionLog } from "./log.js";
import { indexPath, renderDecisionIndex } from "./log-index.js";
import { verifyDecisions } from "./verify.js";
import { followScopeRenames } from "./write.js";

/** The hooks adr registers, in the order the text output lists them. */
const HOOKS: readonly HookName[] = ["pre-commit", "commit-msg", "pre-push", "post-merge"];

/** `adr hooks … --json` (design 2b §4.3); `hooks run` prints `ledger-findings/v1` instead. */
export interface HooksResultJson {
  readonly format: "adr-hooks/v1";
  readonly action: "install" | "uninstall" | "print" | "trailers";
  /** Repo-relative shim paths written or removed. */
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  readonly registrations: readonly { readonly hook: HookName; readonly argv: readonly string[] }[];
  /** `print` only. */
  readonly snippet: string | null;
  /** `trailers` only: the trailers added, in order. */
  readonly trailers: readonly (readonly [string, string])[];
}

/**
 * adr's command per hook (design 2b D4), after `adr`. `--root <root>` comes first only when the
 * root can't be found without it: no `<repo>/adr.toml` names it and it isn't `docs/adr`. So the
 * hooks see the same config as a plain `adr` run, and never print the root-override note.
 */
export function decisionHookCommands(
  log: DecisionLog,
): Partial<Record<HookName, readonly string[]>> {
  const r =
    log.configPath === "adr.toml" || log.layout.root === adrKind.def.defaultRoot
      ? []
      : ["--root", log.layout.root];
  return {
    "pre-commit": [...r, "hooks", "run", "pre-commit"],
    "commit-msg": [...r, "hooks", "trailers", "{args}"],
    "pre-push": [...r, "verify", "--base", "@{upstream}", "--ref", "HEAD"],
    "post-merge": [...r, "list", "--since", "ORIG_HEAD"],
  };
}

function registrations(log: DecisionLog): HooksResultJson["registrations"] {
  const commands = decisionHookCommands(log);
  return HOOKS.flatMap((hook) => {
    const argv = commands[hook];
    return argv === undefined ? [] : [{ hook, argv }];
  });
}

/** A shim path as the user sees it: repo-relative, with `/`. */
function shown(git: Git, path: string): string {
  return relative(git.root ?? git.gitDir, path)
    .split(sep)
    .join("/");
}

/** The shims in hook order: `HOOKS`' order, as the text output lists them. */
function inHookOrder(git: Git, paths: readonly string[]): string[] {
  const rank = (p: string) => HOOKS.findIndex((h) => p.endsWith(`/${h}`));
  return paths.map((p) => shown(git, p)).sort((a, b) => rank(a) - rank(b));
}

function result(
  log: DecisionLog,
  action: HooksResultJson["action"],
  r: HookInstallResult | null,
  extra: Partial<Pick<HooksResultJson, "snippet" | "trailers">> = {},
): HooksResultJson {
  return {
    format: "adr-hooks/v1",
    action,
    written: r === null ? [] : inHookOrder(log.git, r.written),
    unchanged: r === null ? [] : inHookOrder(log.git, r.unchanged),
    registrations: registrations(log),
    snippet: extra.snippet ?? null,
    trailers: extra.trailers ?? [],
  };
}

/**
 * Registers adr's four commands in ledger's shims, one per hook and shared with other ark tools
 * (design 2b D4). With `core.hooksPath` set or a foreign hook file present, it writes the rest and
 * then throws `HookConflictError` (exit 2), naming each conflict and the `print` command.
 */
export async function installDecisionHooks(log: DecisionLog): Promise<HooksResultJson> {
  const r = await installHooks(log.git, { tool: "adr", commands: decisionHookCommands(log) });
  assertNoHookConflicts(r, { tool: "adr" });
  return result(log, "install", r);
}

/** Removes adr from every shim; a shim left with no tool is deleted. */
export async function uninstallDecisionHooks(log: DecisionLog): Promise<HooksResultJson> {
  return result(log, "uninstall", await uninstallHooks(log.git, { tool: "adr" }));
}

/** The config to paste into a hook manager instead of installing shims. */
export function printDecisionHooks(log: DecisionLog, manager: HookManager): HooksResultJson {
  const regs = registrations(log).map((r) => ({ tool: "adr", ...r }));
  return result(log, "print", null, { snippet: hookSnippet(manager, regs) });
}

/** The `ADR-Event` trailer key as git compares keys: case-insensitively. */
const ADR_EVENT = /^adr-event[ \t]*:/im;

/**
 * The `commit-msg` step (P1 §7.1): appends one `ADR`/`ADR-Event` pair per staged added event file
 * of the log, by path, keeping repeats (`ifExists: "add"`). It does nothing for a message that
 * already has an `ADR-Event:` trailer (an `adr … --commit` message), or during a merge, whose
 * events came with their own commits' trailers. Throws `UsageError` when the file is missing.
 */
export async function addHookTrailers(
  log: DecisionLog,
  messageFile: string,
): Promise<HooksResultJson> {
  const { git, layout } = log;
  const file = resolve(git.root ?? git.gitDir, messageFile);
  try {
    await access(file, constants.R_OK | constants.W_OK);
  } catch {
    throw new UsageError(`no commit message file at ${messageFile}`);
  }
  const parsed = await git.run(["interpret-trailers", "--parse", "--", file]);
  if (ADR_EVENT.test(Buffer.from(parsed.stdout).toString("utf8"))) {
    return result(log, "trailers", null);
  }
  if ((await git.resolveCommit("MERGE_HEAD")) !== null) return result(log, "trailers", null);
  const added = await git.stagedPaths([`${layout.root}/${layout.events}`], { addedOnly: true });
  const trailers = added.flatMap((p): Trailer[] => {
    const c = classifyPath(layout, p);
    const name = c.area === "event" && !c.file.includes("/") ? parseEventFileName(c.file) : null;
    return c.area === "event" && c.subject !== null && name !== null
      ? [
          ["ADR", c.subject],
          ["ADR-Event", name.type],
        ]
      : [];
  });
  await git.appendTrailers(file, trailers, { ifExists: "add" });
  return result(log, "trailers", null, { trailers });
}

/**
 * Whether the hook may stage: only into the commit's real index (design 2b D8). `git commit
 * <paths>` and `--only`, adr's own `--commit` included, run hooks on a temporary index, and
 * staging there leaves the user's index showing the file as deleted.
 */
function stagingSafe(git: Git, env: NodeJS.ProcessEnv): boolean {
  const file = env.GIT_INDEX_FILE;
  if (file === undefined || file === "") return true;
  const at = resolve(git.root ?? git.gitDir, file);
  return at === resolve(git.gitDir, "index") || at === resolve(git.gitDir, "index.lock");
}

/** `ADR-0003, ADR-0004` for the decisions a rename following changes. */
const displays = (views: readonly { readonly display: string }[]) =>
  views.map((v) => v.display).join(", ");

/**
 * `adr hooks run pre-commit` (design 2b D8): rename following, then the index, then `verify
 * --staged`, stopping at the first step that fails. `worktree` must be opened with the work-tree
 * reader, because rename following writes through `write()`; `index` with the index reader, for
 * the config as staged, the index render and verify. Only the index step stages `index.md`, and
 * only with `[hooks] index = "stage"`; rename following passes `index: "skip"`. Neither stages
 * into a temporary index (`stagingSafe`). A step that can't run throws (exit 2).
 */
export async function runPreCommitHook(o: {
  readonly worktree: DecisionLog;
  readonly index: DecisionLog;
  readonly env: NodeJS.ProcessEnv;
}): Promise<{
  readonly exit: 0 | 1;
  readonly findings: readonly Finding[];
  readonly notes: readonly string[];
  readonly failOn: Severity;
}> {
  const { worktree, index, env } = o;
  const config = index.adr;
  const failOn = config.failOn;
  const notes: string[] = [...index.notes];
  const done = (exit: 0 | 1, findings: readonly Finding[]) => ({
    exit,
    findings,
    notes: [...new Set(notes)],
    failOn,
  });
  const safe = stagingSafe(index.git, env);

  // 1. Renames, on the work-tree log.
  if (config.scopeFollowRenames !== "off" && (await stagedRenames(worktree.git)).length > 0) {
    const { actor, notes: attribution } = await resolveAttribution(worktree.git, { env });
    if (config.scopeFollowRenames === "warn") {
      const dry = await followScopeRenames(worktree, { actor }, { dryRun: true });
      for (const v of dry.affected) {
        notes.push(
          `${v.display}'s globs don't follow the renames in this commit (scope_follow_renames = "warn"); run adr scope --follow-renames`,
        );
      }
    } else if (safe) {
      const doc = await followScopeRenames(
        worktree,
        { actor },
        { index: "skip", notes: attribution },
      );
      notes.push(...doc.notes);
      if (!doc.ok) return done(1, doc.findings);
    } else {
      const dry = await followScopeRenames(worktree, { actor }, { dryRun: true });
      if (dry.affected.length > 0) {
        notes.push(
          `the renames in this commit change the scope of ${displays(dry.affected)}; git commit <paths> can't take the scoped events. Run adr scope --follow-renames, then commit again including the files it lists, or set [hooks] scope_follow_renames = "warn"`,
        );
        return done(1, []);
      }
    }
  }

  // 2. The index, on the index log: regenerated only with [hooks] index = "stage".
  if (config.index === "committed" && config.hookIndex === "stage" && safe) {
    const path = indexPath(index.layout);
    const text = await renderDecisionIndex(index.git, {
      layout: index.layout,
      adr: config,
      tree: index.tree,
      history: await index.git.resolveCommit("HEAD"),
    });
    if (text !== null && !holdsText(await index.tree.read(path), text)) {
      await writeIndexFile(index.git, path, text);
      await index.git.add([path]);
      notes.push(`regenerated and staged ${path}`);
    }
  }

  // 3. verify --staged, which also reports a stale index.md in check mode.
  const findings = await verifyDecisions(index, { type: "staged" });
  return done(exitCode(findings, { failOn }), findings);
}
