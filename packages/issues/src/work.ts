import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eventDir, type Finding, finding, UsageError } from "@nikovirtala/ledger";
import { type IssueView, issueKind, LOCAL_ID } from "./kind.js";
import { type IssueLog, type IssuesRead, readIssues, readNotes, resolveIssue } from "./log.js";

/** `issues work [<issue>] [--clear] --json`. */
export interface IssueWorkJson {
  readonly format: "issues-work/v1";
  readonly ok: boolean;
  /** The current issue after the command. */
  readonly current: IssueView | null;
  /** The absolute path of the file. */
  readonly path: string;
  /** `issue/work-closed` when refused. */
  readonly findings: readonly Finding[];
  readonly notes: readonly string[];
}

const MAX_BYTES = 64;
const ID = new RegExp(LOCAL_ID);

/**
 * The current-issue file: `<git dir>/issues-current`, so each worktree of a clone has its own
 * (`git rev-parse --git-path`); untracked, and never part of the log's state.
 */
export const currentIssuePath = (log: IssueLog): string => join(log.git.gitDir, "issues-current");

/** The id in the file and a note when its content isn't one; `id: null` when unset. */
async function readFileId(log: IssueLog): Promise<{ id: string | null; note: string | null }> {
  const path = currentIssuePath(log);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { id: null, note: null };
    throw new UsageError(`can't read ${path}: ${(err as NodeJS.ErrnoException).code ?? err}`);
  }
  const text = bytes.byteLength > MAX_BYTES ? "" : new TextDecoder().decode(bytes).trim();
  if (ID.test(text)) return { id: text, note: null };
  return { id: null, note: `ignoring ${path}: not an issue id` };
}

/** The current issue's canonical id, or `null` when unset or unreadable (PR 2's commit-msg hook). */
export async function readCurrentIssue(log: IssueLog): Promise<string | null> {
  return (await readFileId(log)).id;
}

function doc(
  log: IssueLog,
  read: IssuesRead,
  o: { ok: boolean; current: IssueView | null; findings?: Finding[]; notes?: (string | null)[] },
): IssueWorkJson {
  return {
    format: "issues-work/v1",
    ok: o.ok,
    current: o.current,
    path: currentIssuePath(log),
    findings: o.findings ?? [],
    notes: [...readNotes(read), ...(o.notes ?? []).filter((n): n is string => n !== null)],
  };
}

/** The current issue's view: `null` when unset, or when the file names no issue of the log. */
async function current(
  log: IssueLog,
  read: IssuesRead,
): Promise<{ view: IssueView | null; note: string | null }> {
  const { id, note } = await readFileId(log);
  if (id === null) return { view: null, note };
  const view = read.projection.views.get(id) ?? null;
  return {
    view,
    note: view === null ? `ignoring ${currentIssuePath(log)}: ${id} is not in the log` : null,
  };
}

/** `issues work`: the current issue, or `current: null` with the note "no current issue". */
export async function showCurrentIssue(log: IssueLog): Promise<IssueWorkJson> {
  const read = await readIssues(log);
  const { view, note } = await current(log, read);
  return doc(log, read, {
    ok: true,
    current: view,
    notes: [note, view === null ? "no current issue" : null],
  });
}

/**
 * `issues work <issue>`: writes the issue's canonical id to the current-issue file. A closed issue
 * is refused with `issue/work-closed`, naming the canonical issue for a duplicate; nothing is
 * written then.
 */
export async function setCurrentIssue(log: IssueLog, input: string): Promise<IssueWorkJson> {
  const read = await readIssues(log);
  const id = resolveIssue(read, input);
  const view = read.projection.views.get(id) as IssueView;
  if (view.state === "closed") {
    const display = (x: string) => read.projection.views.get(x)?.display ?? x;
    const canonical = view.canonical ?? view.id;
    const message =
      view.resolution === "duplicate" && canonical !== view.id
        ? `${view.display} is closed as a duplicate of ${display(canonical)}; work on ${display(canonical)}`
        : `${view.display} is closed; reopen it before working on it`;
    const loaded = read.folded.subjects.get(id)?.loaded;
    const before = await current(log, read);
    return doc(log, read, {
      ok: false,
      current: before.view,
      findings: [
        finding({
          severity: "error",
          rule: "issue/work-closed",
          message,
          file: loaded?.bodyPaths[0] ?? eventDir(read.layout, id),
          subject: id,
          kind: issueKind.name,
        }),
      ],
      notes: [before.note],
    });
  }
  const path = currentIssuePath(log);
  await writeFile(path, `${view.id}\n`).catch((err: NodeJS.ErrnoException) => {
    throw new UsageError(`can't write ${path}: ${err.code ?? err.message}`);
  });
  return doc(log, read, { ok: true, current: view });
}

/** `issues work --clear`: removes the current-issue file. */
export async function clearCurrentIssue(log: IssueLog): Promise<IssueWorkJson> {
  const read = await readIssues(log);
  const path = currentIssuePath(log);
  await rm(path, { force: true }).catch((err: NodeJS.ErrnoException) => {
    throw new UsageError(`can't remove ${path}: ${err.code ?? err.message}`);
  });
  return doc(log, read, { ok: true, current: null });
}
