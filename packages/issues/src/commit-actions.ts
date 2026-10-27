import { type EventRef, joinActions, MIN_TITLE_ROOM } from "@nikovirtala/ledger";

/**
 * `{action}` of each write's commit (design "Commit messages and trailers", ?6). The title slot
 * holds the title in quotes for `new`, and the issue's display with its title in quotes for every
 * other write (`close ?42 "split the orders service"`), plus the action's own words after it
 * (`as won't fix`, `to ?17`). `init` and `index` name what they write instead.
 */
export const ACTIONS = {
  new: "open",
  edit: "edit",
  start: "start work on",
  stop: "stop work on",
  close: "close",
  reopen: "reopen",
  assign: "set the assignees of",
  label: "set the labels of",
  scope: "set the scope of",
  comment: "comment on",
  link: "link",
  unlink: "unlink",
  init: "set up",
} as const satisfies Record<string, string>;

/** What `issues init --commit`'s title slot holds. */
export const INIT_TITLE = "the issue log";

/** `{action}` of `issues index --commit`, whose title slot holds `the issue index`. */
export const INDEX_ACTION = "regenerate";

/** What `issues index --commit`'s title slot holds. */
export const INDEX_TITLE = "the issue index";

/** The longest display: `?` and up to 9 digits (`formatIssueNumber`, kind/project.ts). */
export const DISPLAY_LENGTH = 10;

/** What a duplicate close's slot names after the title, before the canonical display. */
export const AS_DUPLICATE = "as a duplicate of";

/** What a link's slot names after the title when the target is in another log. */
export const CROSS_LOG_ISSUE = "to an issue in another log";
export const CROSS_LOG_DECISION = "to a decision in another log";

/** The batch verb of each event type, and of `edit`, which writes no event. */
export const BATCH_VERBS: Readonly<Record<string, string>> = Object.freeze({
  edit: "edit",
  opened: "open",
  assigned: "assign",
  started: "start",
  stopped: "stop",
  closed: "close",
  reopened: "reopen",
  labeled: "label",
  linked: "link",
  unlinked: "unlink",
  scoped: "scope",
  commented: "comment on",
});

/** Batch verbs in subject order: `comment on` last, so it reads right before the name. */
const VERB_ORDER = [
  "edit",
  "open",
  "assign",
  "start",
  "stop",
  "close",
  "reopen",
  "label",
  "link",
  "unlink",
  "scope",
  "comment on",
] as const;

/** The action of a batch of more than three verbs. */
export const UPDATE_ACTION = "update";

/** Each command's own batch verb type (`BATCH_VERBS`' key). */
export const PRIMARY_TYPES: Readonly<Record<string, string>> = Object.freeze({
  new: "opened",
  edit: "edit",
  start: "started",
  stop: "stopped",
  close: "closed",
  reopen: "reopened",
  assign: "assigned",
  label: "labeled",
  link: "linked",
  unlink: "unlinked",
  scope: "scoped",
  comment: "commented",
});

/** The longest three-verb batch action, in subject order. */
const LONGEST_BATCH: number = (() => {
  let longest = 0;
  for (let i = 0; i < VERB_ORDER.length; i++) {
    for (let j = i + 1; j < VERB_ORDER.length; j++) {
      for (let k = j + 1; k < VERB_ORDER.length; k++) {
        const a = [VERB_ORDER[i], VERB_ORDER[j], VERB_ORDER[k]] as string[];
        longest = Math.max(longest, joinActions(a).length);
      }
    }
  }
  return longest;
})();

/** The longest `{action}`, which `[commit] subject` must leave room for. */
export const LONGEST_ACTION: number = Math.max(
  ...Object.values(ACTIONS).map((a) => a.length),
  INDEX_ACTION.length,
  LONGEST_BATCH,
);

/** issues' commit-subject placeholders, each with its longest value. */
export const COMMIT_VARS = Object.freeze({
  action: LONGEST_ACTION,
  id: 8,
  display: DISPLAY_LENGTH,
  command: "comment".length,
});

/** `"<title>"` with the room a title needs. */
const QUOTED = 2 + MIN_TITLE_ROOM;
/** `<display> "<title>"`. */
const NAMED = DISPLAY_LENGTH + 1 + QUOTED;
/** The several-issues name at its longest: `<display> and 999 other issues`. */
const SEVERAL = DISPLAY_LENGTH + " and 999 other issues".length;
const longestOf = (...actions: readonly string[]) => Math.max(...actions.map((a) => a.length));

/**
 * The slot forms the title placeholder holds, each with its longest action, so the default
 * template parses and a custom one that can't fit them is refused at config load: `new`'s quoted
 * title; a display with a quoted title for every other single action; a duplicate close's and a
 * cross-log link's words after it; a batch's name for one issue and for several; and init's and
 * index's names. The other forms are shorter with the same actions.
 */
export const COMMIT_NAMES = Object.freeze([
  { length: QUOTED, vars: { action: ACTIONS.new.length } },
  {
    length: NAMED,
    vars: {
      action: longestOf(
        ACTIONS.edit,
        ACTIONS.start,
        ACTIONS.stop,
        ACTIONS.reopen,
        ACTIONS.assign,
        ACTIONS.label,
        ACTIONS.scope,
        ACTIONS.comment,
      ),
    },
  },
  {
    length: NAMED + 1 + AS_DUPLICATE.length + 1 + DISPLAY_LENGTH,
    vars: { action: ACTIONS.close.length },
  },
  {
    length: NAMED + 1 + `from ${CROSS_LOG_DECISION.slice(3)}`.length,
    vars: { action: longestOf(ACTIONS.link, ACTIONS.unlink) },
  },
  { length: NAMED, vars: { action: LONGEST_BATCH } },
  { length: SEVERAL, vars: { action: LONGEST_BATCH } },
  { length: INIT_TITLE.length, vars: { action: ACTIONS.init.length } },
  { length: INDEX_TITLE.length, vars: { action: INDEX_ACTION.length } },
]);

/** What a batch commit's action and name are, or `null` for the write's normal subject. */
export interface BatchSubject {
  readonly action: string;
  /** `null` names the command's issue as `<display> "<title>"`; else the several-issues name. */
  readonly name: string | null;
}

/**
 * The batch rule (?6): the verb set is the command's own verb plus the verb of each extra staged
 * event's type; the plan's own events never add one (new's `labeled`, start's `assigned`). With
 * one verb the write keeps its normal subject (`null`). With two or three, they are joined in
 * subject order (`link and scope`), with four or more the action is `update`. The name is the
 * command's issue when every event is about it, else `<display> and <n> other issues` (`and more
 * issues` beyond 999).
 */
export function composeSubject(o: {
  readonly command: string;
  readonly subject: string;
  readonly display: string;
  readonly plan: readonly EventRef[];
  readonly extra: readonly EventRef[];
}): BatchSubject | null {
  const primary = PRIMARY_TYPES[o.command];
  if (primary === undefined) return null;
  const verbs = new Set<string>([BATCH_VERBS[primary] as string]);
  for (const e of o.extra) {
    const verb = BATCH_VERBS[e.type];
    if (verb !== undefined && e.type !== "edit") verbs.add(verb);
  }
  if (verbs.size <= 1) return null;
  const ordered = VERB_ORDER.filter((v) => verbs.has(v));
  const action = ordered.length > 3 ? UPDATE_ACTION : joinActions(ordered);
  const others = new Set([...o.plan, ...o.extra].map((e) => e.subject));
  others.delete(o.subject);
  const n = others.size;
  if (n === 0) return { action, name: null };
  const tail = n > 999 ? "and more issues" : `and ${n} other issue${n === 1 ? "" : "s"}`;
  return { action, name: `${o.display} ${tail}` };
}
