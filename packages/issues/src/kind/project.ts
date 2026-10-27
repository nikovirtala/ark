import type { FoldedSubject, ProjectContext } from "@nikovirtala/ledger";
import { issueGraph } from "./graph.js";
import type { IssueState } from "./reduce.js";
import type { SourceLog } from "./rules.js";
import type { IssueEvents, IssueStatus, Resolution } from "./schemas.js";

/** One issue as the CLI, the library and MCP show it (02 Projection, plus the added fields). */
export interface IssueView {
  readonly id: string;
  readonly number: number | null;
  /** `?42`, or the id when unnumbered. */
  readonly display: string;
  /** The body's `# ` heading, else `opened.title`. */
  readonly title: string;
  readonly state: IssueStatus;
  readonly resolution: Resolution | null;
  readonly duplicate_of: string | null;
  /** The issue that tracks the work: this one unless it is a duplicate; `null` only on a cycle. */
  readonly canonical: string | null;
  /** Issues currently closed as duplicates of this one, sorted. */
  readonly duplicates: readonly string[];
  readonly assignees: readonly string[];
  readonly labels: readonly string[];
  readonly parent: string | null;
  readonly children: readonly string[];
  readonly depends_on: readonly string[];
  readonly blocks: readonly string[];
  /** Canonical issues of local dependencies that aren't closed, sorted. */
  readonly blocked_by_open: readonly string[];
  readonly blocked: boolean;
  readonly ready: boolean;
  readonly relates_to: readonly string[];
  readonly implements: readonly string[];
  readonly applies_to: readonly string[];
  readonly comments: number;
  readonly template: { readonly name: string; readonly version: number };
  readonly body_path: string | null;
  readonly opened_at: string;
  readonly closed_at: string | null;
  readonly state_at: string;
  /** `opened 2026-10-20`: state-changing events, in fold order. */
  readonly history: readonly string[];
}

type Subject = FoldedSubject<IssueStatus, IssueState, IssueEvents>;
type Context = ProjectContext<IssueStatus, IssueState, IssueEvents>;

const NUMBER = /^\??0*([1-9][0-9]{0,8})$/;
const decoder = new TextDecoder();

/** `?42`. The prefix keeps forges from linking the number to their own issues. */
export function formatIssueNumber(n: number): string {
  return `?${n}`;
}

/** `42`, `?42`, `0042` → 42; `null` for anything else. */
export function parseIssueNumber(s: string): number | null {
  const m = NUMBER.exec(s.trim());
  return m === null ? null : Number(m[1]);
}

/** The first `# ` line of a body, trimmed, when it isn't empty. */
export function bodyTitle(body: Uint8Array): string | null {
  for (const line of decoder.decode(body).split(/\r?\n/)) {
    if (!line.startsWith("# ")) continue;
    const title = line.slice(2).trim();
    return title === "" ? null : title;
  }
  return null;
}

/** What `projectLog` may pass the issue kind's projection: the other logs references name. */
export interface ProjectOptions {
  readonly sources: ReadonlyMap<string, SourceLog> | null;
}

/**
 * The `depends-on <source>:<id>` targets known in a read source that aren't closed (for a
 * duplicate, its canonical issue's status in the same source): blockers in other repositories.
 */
function foreignBlockers(dependsOn: readonly string[], options: unknown): string[] {
  const sources = (options as ProjectOptions | undefined)?.sources ?? null;
  if (sources === null) return [];
  return dependsOn.filter((to) => {
    const at = to.indexOf(":");
    if (at < 0) return false;
    const source = sources.get(to.slice(0, at));
    if (source === undefined || source.kind !== "issues" || source.subjects === null) return false;
    const found = source.subjects.get(to.slice(at + 1));
    if (found === undefined) return false;
    const canonical =
      found.effective === null ? found : (source.subjects.get(found.effective) ?? found);
    return canonical.status !== "closed";
  });
}

/** Pure: the view of one folded issue. */
export function project(subject: Subject, ctx: Context): IssueView {
  const { id } = subject;
  const s = subject.state;
  const fields = issueGraph(ctx.log).fields(id);
  if (s === null || subject.status === null || fields === null) {
    throw new Error(`issue ${id} is not folded`);
  }
  const foreign = foreignBlockers(fields.depends_on, ctx.options);
  const blocked = fields.blocked || (subject.status !== "closed" && foreign.length > 0);
  const body = subject.loaded.body;
  return {
    id,
    number: ctx.number(id),
    display: ctx.display(id),
    title: (body === null || body === undefined ? null : bodyTitle(body.bytes)) ?? s.title,
    state: subject.status,
    resolution: s.resolution,
    duplicate_of: s.duplicateOf,
    canonical: fields.canonical,
    duplicates: fields.duplicates,
    assignees: s.assignees,
    labels: s.labels,
    parent: fields.parent,
    children: fields.children,
    depends_on: fields.depends_on,
    blocks: fields.blocks,
    blocked_by_open: [...fields.blocked_by_open, ...foreign],
    blocked,
    ready: fields.ready && foreign.length === 0,
    relates_to: fields.relates_to,
    implements: fields.implements,
    applies_to: s.appliesTo,
    comments: s.comments,
    template: s.template,
    body_path: body?.path ?? subject.loaded.bodyPaths[0] ?? null,
    opened_at: s.openedAt,
    closed_at: s.closedAt,
    state_at: s.stateAt,
    history: s.history.map((h) => `${h.type} ${h.at.slice(0, 10)}`),
  };
}
