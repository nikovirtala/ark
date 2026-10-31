import { access, constants } from "node:fs/promises";
import { resolve } from "node:path";
import type { Actor } from "../envelope/types.js";
import { UsageError } from "../errors.js";
import { exitCode, type Finding, type Severity } from "../findings/finding.js";
import type { Git, Trailer } from "../git/git.js";
import { withGitOperation } from "../git/operation.js";
import type { LogLayout } from "../identity/layout.js";
import { holdsText } from "../log-index/copies.js";
import { indexPath } from "../log-index/tool-render.js";
import { writeIndexFile } from "../log-index/write.js";
import { stagedRenames } from "../scope/renames.js";
import { resolveAttribution } from "./actor.js";
import { type EventRef, eventTrailers, stagedEventRefs } from "./commit-message.js";
import type { LogIndexRender } from "./tool-index.js";
import type { SharedKeys, ToolLog } from "./tool-log.js";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The start of a tool's `commit-msg` step: the message file `messageFile` (resolved against the
 * work tree, else the git dir) and its trailers as `git interpret-trailers --parse` prints them,
 * or `null` when the step has nothing to do: the message already has a `<keys.event>:` trailer
 * (keys compared case-insensitively, as git does), such as a `<tool> … --commit` message, or a
 * merge is in progress, whose events came with their own commits' trailers. Throws `UsageError`
 * when the file is missing or can't be read and written.
 */
export async function readCommitMessage(
  git: Git,
  messageFile: string,
  keys: { readonly event: string },
): Promise<{ readonly file: string; readonly parsed: string } | null> {
  const file = resolve(git.root ?? git.gitDir, messageFile);
  try {
    await access(file, constants.R_OK | constants.W_OK);
  } catch {
    throw new UsageError(`no commit message file at ${messageFile}`);
  }
  const parsed = Buffer.from(
    (await git.run(["interpret-trailers", "--parse", "--", file])).stdout,
  ).toString("utf8");
  if (new RegExp(`^${escapeRegExp(keys.event)}[ \\t]*:`, "im").test(parsed)) return null;
  if ((await git.resolveCommit("MERGE_HEAD")) !== null) return null;
  return { file, parsed };
}

/**
 * The staged added event files of the log at `layout` as refs (`stagedEventRefs`), and their
 * trailers (`eventTrailers`): one `[keys.subject, subject]`, `[keys.event, type]` pair per subject
 * and event type, in path order.
 */
export async function stagedEventTrailers(
  git: Git,
  layout: LogLayout,
  keys: { readonly subject: string; readonly event: string },
): Promise<{ readonly refs: EventRef[]; readonly trailers: Trailer[] }> {
  const added = await git.stagedPaths([`${layout.root}/${layout.events}`], { addedOnly: true });
  const refs = stagedEventRefs(layout, added);
  return { refs, trailers: eventTrailers(refs, keys) };
}

/**
 * A tool's rename following (its `followScopeRenames`), in the two ways the pre-commit step runs
 * it: `{ dryRun: true }` only reports the subjects whose scope would change (`affected`); `{ index:
 * "skip", notes }` writes and stages their scope events, leaving `index.md` to the index step.
 */
export type FollowRenames<L extends ToolLog> = (
  log: L,
  input: { readonly actor: Actor },
  o: { readonly dryRun: true } | { readonly index: "skip"; readonly notes: readonly string[] },
) => Promise<{
  readonly ok: boolean;
  readonly findings: readonly Finding[];
  readonly notes: readonly string[];
  readonly affected: readonly { readonly display: string }[];
}>;

export interface PreCommitHookOptions<L extends ToolLog> {
  /** The tool's name, for the notes: `run <tool> scope --follow-renames`. */
  readonly tool: string;
  /** The log opened with the work-tree reader: rename following writes through it. */
  readonly worktree: L;
  /** The log opened with the index reader: the config as staged, the index render and verify. */
  readonly index: L;
  readonly env: NodeJS.ProcessEnv;
  /** The index log's `[verify] fail_on`, `[hooks]` keys and `[log] index`. */
  readonly config: Pick<SharedKeys, "failOn" | "scopeFollowRenames" | "hookIndex" | "index">;
  readonly followRenames: FollowRenames<L>;
  /** The index log's render of `<root>/index.md` (`renderLogIndex` with the tool's spec bound). */
  readonly renderIndex: LogIndexRender;
  /** `verify --staged` on the index log. */
  readonly verify: () => Promise<readonly Finding[]>;
  /**
   * Leave out the staged rename following's notes the work-tree log already has (its location
   * notes, which a tool's write reports first). Default `false`, which keeps them.
   */
  readonly dropWorktreeNotes?: boolean;
}

export interface PreCommitHookResult {
  readonly exit: 0 | 1;
  readonly findings: readonly Finding[];
  readonly notes: readonly string[];
  readonly failOn: Severity;
}

/**
 * Whether the hook may stage: only into the commit's real index (design 2b D8). `git commit
 * <paths>` and `--only`, a tool's own `--commit` included, run hooks on a temporary index, and
 * staging there leaves the user's index showing the file as deleted.
 */
function stagingSafe(git: Git, env: NodeJS.ProcessEnv): boolean {
  const file = env.GIT_INDEX_FILE;
  if (file === undefined || file === "") return true;
  const at = resolve(git.root ?? git.gitDir, file);
  return at === resolve(git.gitDir, "index") || at === resolve(git.gitDir, "index.lock");
}

/** `ADR-0003, ADR-0004` for the subjects a rename following changes. */
const displays = (views: readonly { readonly display: string }[]) =>
  views.map((v) => v.display).join(", ");

/**
 * `<tool> hooks run pre-commit` (design 2b D8): rename following, then the index, then `verify
 * --staged`, stopping at the first step that fails. Rename following runs on the work-tree log
 * with `[hooks] scope_follow_renames` `stage` (with `warn`, a note per affected subject; with
 * `off`, not at all). The index step regenerates and stages `index.md` only with `[log] index =
 * "committed"` and `[hooks] index = "stage"`; rename following passes `index: "skip"`. Neither
 * stages into a temporary index (`stagingSafe`): with one, renames that change a scope fail the
 * hook with a note. The exit is verify's by `[verify] fail_on`; the notes start with the index
 * log's and are deduplicated. A step that can't run throws (exit 2).
 */
export function runPreCommitHook<L extends ToolLog>(
  o: PreCommitHookOptions<L>,
): Promise<PreCommitHookResult> {
  return withGitOperation(async () => {
    const { worktree, index, env, config, tool } = o;
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
        const dry = await o.followRenames(worktree, { actor }, { dryRun: true });
        for (const v of dry.affected) {
          notes.push(
            `${v.display}'s globs don't follow the renames in this commit (scope_follow_renames = "warn"); run ${tool} scope --follow-renames`,
          );
        }
      } else if (safe) {
        const doc = await o.followRenames(
          worktree,
          { actor },
          { index: "skip", notes: attribution },
        );
        notes.push(
          ...(o.dropWorktreeNotes === true
            ? doc.notes.filter((n) => !worktree.notes.includes(n))
            : doc.notes),
        );
        if (!doc.ok) return done(1, doc.findings);
      } else {
        const dry = await o.followRenames(worktree, { actor }, { dryRun: true });
        if (dry.affected.length > 0) {
          notes.push(
            `the renames in this commit change the scope of ${displays(dry.affected)}; git commit <paths> can't take the scoped events. Run ${tool} scope --follow-renames, then commit again including the files it lists, or set [hooks] scope_follow_renames = "warn"`,
          );
          return done(1, []);
        }
      }
    }

    // 2. The index, on the index log: regenerated only with [hooks] index = "stage".
    if (config.index === "committed" && config.hookIndex === "stage" && safe) {
      const path = indexPath(index.layout);
      const text = await o.renderIndex(index.git, {
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
    const findings = await o.verify();
    return done(exitCode(findings, { failOn }), findings);
  });
}
