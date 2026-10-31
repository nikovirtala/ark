import { readFile } from "node:fs/promises";
import {
  type HookManager,
  type HookName,
  installToolHooks,
  type PreCommitHookResult,
  printToolHooks,
  readCommitMessage,
  runPreCommitHook as runToolPreCommitHook,
  stagedEventTrailers,
  type ToolHooksJson,
  toolHookCommands,
  toolHooksResult,
  UsageError,
  uninstallToolHooks,
  withGitOperation,
} from "@nikovirtala/ledger";
import { type IssueLog, readIssues, resolveIssue } from "./log.js";
import { renderIssueIndex } from "./log-index.js";
import { verifyIssues } from "./verify.js";
import { readCurrentIssue } from "./work.js";
import { followScopeRenames } from "./write.js";

/** `issues hooks … --json`; `hooks run` prints `ledger-findings/v1` instead. adr's `adr-hooks/v1`. */
export interface IssueHooksJson extends ToolHooksJson<"issues-hooks/v1"> {
  /** `trailers` only: the notes printed to stderr (a closed current issue, a "fixes ?N"). */
  readonly notes: readonly string[];
}

const SPEC = { tool: "issues", format: "issues-hooks/v1" } as const;
const KEYS = { subject: "Issue", event: "Issue-Event" } as const;

/** The `issues hooks … --json` document of `action`, with the notes. */
const result = (doc: ToolHooksJson<"issues-hooks/v1">, notes: readonly string[] = []) => ({
  ...doc,
  notes,
});

/**
 * issues' command per hook (the approved design's table), after `issues`. `--root <root>` comes
 * first only when the root can't be found without it: no `<repo>/issues.toml` names it and it
 * isn't `docs/issues`. So the hooks see the same config as a plain `issues` run.
 */
export function issueHookCommands(log: IssueLog): Partial<Record<HookName, readonly string[]>> {
  return toolHookCommands(log, "issues");
}

/**
 * Registers issues' commands in ledger's shims, one per hook and shared with other ark tools
 * (ADR-0011). With `core.hooksPath` set or a foreign hook file present, it writes the rest and
 * then throws `HookConflictError` (exit 2), naming each conflict and the `print` command.
 */
export async function installIssueHooks(log: IssueLog): Promise<IssueHooksJson> {
  return result(await installToolHooks(log, SPEC));
}

/** Removes issues from every shim; a shim left with no tool is deleted. */
export async function uninstallIssueHooks(log: IssueLog): Promise<IssueHooksJson> {
  return result(await uninstallToolHooks(log, SPEC));
}

/** The config to paste into a hook manager instead of installing shims. */
export function printIssueHooks(log: IssueLog, manager: HookManager): IssueHooksJson {
  return result(printToolHooks(log, SPEC, manager));
}

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
  return withGitOperation(async () => {
    const { git, layout } = log;
    const message = await readCommitMessage(git, messageFile, KEYS);
    if (message === null) return result(toolHooksResult(log, SPEC, "trailers", null));
    const { file, parsed } = message;
    const { refs, trailers } = await stagedEventTrailers(git, layout, KEYS);
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
    return result(toolHooksResult(log, SPEC, "trailers", null, { trailers }), notes);
  });
}

/**
 * `issues hooks run pre-commit` (adr's three steps, `runPreCommitHook` in ledger): rename
 * following, then the index, then `verify --staged` (widened when a staged input outside the log
 * changes, sources from the cache only), stopping at the first step that fails. `worktree` must be
 * opened with the work-tree reader, because rename following writes through `write()`; `index`
 * with the index reader, for the config as staged, the index render and verify. The rename
 * following's notes leave out the work-tree log's own.
 */
export function runPreCommitHook(o: {
  readonly worktree: IssueLog;
  readonly index: IssueLog;
  readonly env: NodeJS.ProcessEnv;
}): Promise<PreCommitHookResult> {
  const { index } = o;
  const config = index.issues;
  return runToolPreCommitHook({
    ...o,
    tool: "issues",
    config,
    followRenames: followScopeRenames,
    renderIndex: (git, at) =>
      renderIssueIndex(git, { layout: index.layout, issues: config, ...at }),
    verify: () => verifyIssues(index, { type: "staged" }),
    dropWorktreeNotes: true,
  });
}
