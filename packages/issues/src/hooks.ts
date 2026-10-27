import { access, constants, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  assertNoHookConflicts,
  classifyPath,
  type EventRef,
  eventTrailers,
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
import { issueKind } from "./kind.js";
import { type IssueLog, readIssues, resolveIssue } from "./log.js";
import { indexPath, renderIssueIndex } from "./log-index.js";
import { verifyIssues } from "./verify.js";
import { readCurrentIssue } from "./work.js";
import { followScopeRenames } from "./write.js";

/** The hooks issues registers, in the order the text output lists them. */
const HOOKS: readonly HookName[] = ["pre-commit", "commit-msg", "pre-push", "post-merge"];

/** `issues hooks … --json`; `hooks run` prints `ledger-findings/v1` instead. adr's `adr-hooks/v1`. */
export interface IssueHooksJson {
  readonly format: "issues-hooks/v1";
  readonly action: "install" | "uninstall" | "print" | "trailers";
  /** Repo-relative shim paths written or removed. */
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  readonly registrations: readonly { readonly hook: HookName; readonly argv: readonly string[] }[];
  /** `print` only. */
  readonly snippet: string | null;
  /** `trailers` only: the trailers added, in order. */
  readonly trailers: readonly (readonly [string, string])[];
  /** `trailers` only: the notes printed to stderr (a closed current issue, a "fixes ?N"). */
  readonly notes: readonly string[];
}

/**
 * issues' command per hook (the approved design's table), after `issues`. `--root <root>` comes
 * first only when the root can't be found without it: no `<repo>/issues.toml` names it and it
 * isn't `docs/issues`. So the hooks see the same config as a plain `issues` run.
 */
export function issueHookCommands(log: IssueLog): Partial<Record<HookName, readonly string[]>> {
  const r =
    log.configPath === "issues.toml" || log.layout.root === issueKind.def.defaultRoot
      ? []
      : ["--root", log.layout.root];
  return {
    "pre-commit": [...r, "hooks", "run", "pre-commit"],
    "commit-msg": [...r, "hooks", "trailers", "{args}"],
    "pre-push": [...r, "verify", "--base", "@{upstream}", "--ref", "HEAD", "--fetch-sources"],
    "post-merge": [...r, "list", "--since", "ORIG_HEAD"],
  };
}

function registrations(log: IssueLog): IssueHooksJson["registrations"] {
  const commands = issueHookCommands(log);
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

/** The shims in hook order. */
function inHookOrder(git: Git, paths: readonly string[]): string[] {
  const rank = (p: string) => HOOKS.findIndex((h) => p.endsWith(`/${h}`));
  return paths.map((p) => shown(git, p)).sort((a, b) => rank(a) - rank(b));
}

function result(
  log: IssueLog,
  action: IssueHooksJson["action"],
  r: HookInstallResult | null,
  extra: Partial<Pick<IssueHooksJson, "snippet" | "trailers" | "notes">> = {},
): IssueHooksJson {
  return {
    format: "issues-hooks/v1",
    action,
    written: r === null ? [] : inHookOrder(log.git, r.written),
    unchanged: r === null ? [] : inHookOrder(log.git, r.unchanged),
    registrations: registrations(log),
    snippet: extra.snippet ?? null,
    trailers: extra.trailers ?? [],
    notes: extra.notes ?? [],
  };
}

/**
 * Registers issues' commands in ledger's shims, one per hook and shared with other ark tools
 * (ADR-0011). With `core.hooksPath` set or a foreign hook file present, it writes the rest and
 * then throws `HookConflictError` (exit 2), naming each conflict and the `print` command.
 */
export async function installIssueHooks(log: IssueLog): Promise<IssueHooksJson> {
  const r = await installHooks(log.git, { tool: "issues", commands: issueHookCommands(log) });
  assertNoHookConflicts(r, { tool: "issues" });
  return result(log, "install", r);
}

/** Removes issues from every shim; a shim left with no tool is deleted. */
export async function uninstallIssueHooks(log: IssueLog): Promise<IssueHooksJson> {
  return result(log, "uninstall", await uninstallHooks(log.git, { tool: "issues" }));
}

/** The config to paste into a hook manager instead of installing shims. */
export function printIssueHooks(log: IssueLog, manager: HookManager): IssueHooksJson {
  const regs = registrations(log).map((r) => ({ tool: "issues", ...r }));
  return result(log, "print", null, { snippet: hookSnippet(manager, regs) });
}

/** The `Issue-Event` trailer key as git compares keys: case-insensitively. */
const ISSUE_EVENT = /^issue-event[ \t]*:/im;
/** An `Issue:` trailer line of `git interpret-trailers --parse` output. */
const ISSUE_TRAILER = /^issue[ \t]*:[ \t]*(\S+)[ \t]*$/gim;
/** A message's "fixes ?42", "closes: 1w06qws8", "resolved ?3" (02 "Closing from commit messages"). */
const FIXES =
  /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\b[ \t]*:?[ \t]*(\?[0-9]{1,9}|[0-9a-hjkmnp-tv-z]{8})\b/gi;
/** A trailer line, as the last paragraph of a message holds them. */
const TRAILER_LINE = /^[A-Za-z0-9][A-Za-z0-9-]*[ \t]*:[ \t]*\S/;

/** The message without `#` comment lines and without its trailer block. */
function prose(message: string): string {
  const lines = message.split("\n").filter((l) => !l.startsWith("#"));
  const paragraphs = lines
    .join("\n")
    .trimEnd()
    .split(/\n[ \t]*\n/);
  const last = paragraphs.at(-1) ?? "";
  const trailerBlock =
    paragraphs.length > 1 && last.split("\n").every((l) => TRAILER_LINE.test(l.trim()));
  return (trailerBlock ? paragraphs.slice(0, -1) : paragraphs).join("\n\n");
}

/**
 * The `commit-msg` step: appends one `Issue`/`Issue-Event` pair per issue and event type among
 * the staged added event files (`eventTrailers`, ?6), then `Issue: <current>` for the current
 * issue (`issues work`) when it isn't closed and no `Issue:` trailer names it yet. It does nothing
 * for a message that already has an `Issue-Event:` trailer (an `issues … --commit` message), or
 * during a merge. Then, as feedback only, a note for each "fixes ?N" (or closes, resolves) naming
 * a local issue with no staged `closed` event: issues don't close from commit messages. Throws
 * `UsageError` when the file is missing.
 */
export async function addHookTrailers(log: IssueLog, messageFile: string): Promise<IssueHooksJson> {
  const { git, layout } = log;
  const file = resolve(git.root ?? git.gitDir, messageFile);
  try {
    await access(file, constants.R_OK | constants.W_OK);
  } catch {
    throw new UsageError(`no commit message file at ${messageFile}`);
  }
  const parsed = Buffer.from(
    (await git.run(["interpret-trailers", "--parse", "--", file])).stdout,
  ).toString("utf8");
  if (ISSUE_EVENT.test(parsed)) return result(log, "trailers", null);
  if ((await git.resolveCommit("MERGE_HEAD")) !== null) return result(log, "trailers", null);
  const added = await git.stagedPaths([`${layout.root}/${layout.events}`], { addedOnly: true });
  const refs = added.flatMap((p): EventRef[] => {
    const c = classifyPath(layout, p);
    const name = c.area === "event" && !c.file.includes("/") ? parseEventFileName(c.file) : null;
    return c.area === "event" && c.subject !== null && name !== null
      ? [{ subject: c.subject, type: name.type }]
      : [];
  });
  const trailers: Trailer[] = eventTrailers(refs, { subject: "Issue", event: "Issue-Event" });
  const notes: string[] = [];
  const read = await readIssues(log);
  const current = await readCurrentIssue(log);
  const view = current === null ? undefined : read.projection.views.get(current);
  if (view !== undefined) {
    const named = new Set([
      ...[...parsed.matchAll(ISSUE_TRAILER)].map((m) => m[1]),
      ...trailers.filter(([k]) => k === "Issue").map(([, v]) => v),
    ]);
    if (view.state === "closed") {
      notes.push(`the current issue ${view.display} is closed; run issues work --clear`);
    } else if (!named.has(view.id)) {
      trailers.push(["Issue", view.id]);
    }
  }
  if (trailers.length > 0) await git.appendTrailers(file, trailers, { ifExists: "add" });

  const closing = new Set(refs.filter((r) => r.type === "closed").map((r) => r.subject));
  const text = prose(await readFile(file, "utf8"));
  const warned = new Set<string>();
  for (const m of text.matchAll(FIXES)) {
    let id: string;
    try {
      id = resolveIssue(read, m[1] as string);
    } catch (err) {
      if (err instanceof UsageError) continue;
      throw err;
    }
    if (closing.has(id) || warned.has(id)) continue;
    warned.add(id);
    const v = read.projection.views.get(id);
    const display = v?.display ?? id;
    notes.push(
      `the message says "${m[0]}", but ${display} has no staged closed event; issues don't close from commit messages, so run issues close ${display.replace(/^\?/, "")} in this pull request`,
    );
  }
  return result(log, "trailers", null, { trailers, notes });
}

/**
 * Whether the hook may stage: only into the commit's real index. `git commit <paths>` and
 * `--only`, issues' own `--commit` included, run hooks on a temporary index, and staging there
 * leaves the user's index showing the file as deleted. adr's `stagingSafe`.
 */
function stagingSafe(git: Git, env: NodeJS.ProcessEnv): boolean {
  const file = env.GIT_INDEX_FILE;
  if (file === undefined || file === "") return true;
  const at = resolve(git.root ?? git.gitDir, file);
  return at === resolve(git.gitDir, "index") || at === resolve(git.gitDir, "index.lock");
}

const displays = (views: readonly { readonly display: string }[]) =>
  views.map((v) => v.display).join(", ");

/**
 * `issues hooks run pre-commit` (adr's three steps): rename following, then the index, then
 * `verify --staged` (widened when a staged input outside the log changes, sources from the cache
 * only), stopping at the first step that fails. `worktree` must be opened with the work-tree
 * reader, because rename following writes through `write()`; `index` with the index reader, for
 * the config as staged, the index render and verify. Only the index step stages `index.md`, and
 * only with `[hooks] index = "stage"`; neither step stages into a temporary index.
 */
export async function runPreCommitHook(o: {
  readonly worktree: IssueLog;
  readonly index: IssueLog;
  readonly env: NodeJS.ProcessEnv;
}): Promise<{
  readonly exit: 0 | 1;
  readonly findings: readonly Finding[];
  readonly notes: readonly string[];
  readonly failOn: Severity;
}> {
  const { worktree, index, env } = o;
  const config = index.issues;
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
          `${v.display}'s globs don't follow the renames in this commit (scope_follow_renames = "warn"); run issues scope --follow-renames`,
        );
      }
    } else if (safe) {
      const doc = await followScopeRenames(
        worktree,
        { actor },
        { index: "skip", notes: attribution },
      );
      notes.push(...doc.notes.filter((n) => !worktree.notes.includes(n)));
      if (!doc.ok) return done(1, doc.findings);
    } else {
      const dry = await followScopeRenames(worktree, { actor }, { dryRun: true });
      if (dry.affected.length > 0) {
        notes.push(
          `the renames in this commit change the scope of ${displays(dry.affected)}; git commit <paths> can't take the scoped events. Run issues scope --follow-renames, then commit again including the files it lists, or set [hooks] scope_follow_renames = "warn"`,
        );
        return done(1, []);
      }
    }
  }

  // 2. The index, on the index log: regenerated only with [hooks] index = "stage".
  if (config.index === "committed" && config.hookIndex === "stage" && safe) {
    const path = indexPath(index.layout);
    const text = await renderIssueIndex(index.git, {
      layout: index.layout,
      issues: config,
      tree: index.tree,
      history: await index.git.resolveCommit("HEAD"),
    });
    if (text !== null && !holdsText(await index.tree.read(path), text)) {
      await writeIndexFile(index.git, path, text);
      await index.git.add([path]);
      notes.push(`regenerated and staged ${path}`);
    }
  }

  // 3. verify --staged, which also reports a stale index.md.
  const findings = await verifyIssues(index, { type: "staged" });
  return done(exitCode(findings, { failOn }), findings);
}
