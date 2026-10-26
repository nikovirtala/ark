/**
 * `{action}` of each write's commit (design "Commit messages and trailers"), and what its title
 * slot names: the issue's title for `new`, else a name built from displays, which is never
 * shortened.
 */
export const ACTIONS = {
  new: "open",
  edit: "edit the description of",
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

/** The longest display: `?` and up to 9 digits (`formatIssueNumber`, kind/project.ts). */
export const DISPLAY_LENGTH = 10;

/** What a duplicate close's title slot names between the two displays. */
export const AS_DUPLICATE = "as a duplicate of";

/** What a link's title slot names after the display when the target is in another log. */
export const CROSS_LOG_ISSUE = "to an issue in another log";
export const CROSS_LOG_DECISION = "to a decision in another log";

/** The longest `{action}`, which `[commit] subject` must leave room for. */
export const LONGEST_ACTION: number = Math.max(...Object.values(ACTIONS).map((a) => a.length));

/** issues' commit-subject placeholders, each with its longest value. */
export const COMMIT_VARS = Object.freeze({
  action: LONGEST_ACTION,
  id: 8,
  display: DISPLAY_LENGTH,
  command: "comment".length,
});

/**
 * The names the title placeholder holds instead of a title, each with its action: a duplicate
 * close's `<display> as a duplicate of <display>`, a link's `<display> to a decision in another
 * log` (the longest link name), and init's `the issue log`. The other names (a display, `<display>
 * as won't fix`, `<display> to <display>`) are shorter with the same actions, so they fit too.
 */
export const COMMIT_NAMES = Object.freeze([
  {
    length: DISPLAY_LENGTH * 2 + ` ${AS_DUPLICATE} `.length,
    vars: { action: ACTIONS.close.length },
  },
  {
    length: DISPLAY_LENGTH + 1 + CROSS_LOG_DECISION.length,
    vars: { action: Math.max(ACTIONS.link.length, ACTIONS.unlink.length) },
  },
  { length: INIT_TITLE.length, vars: { action: ACTIONS.init.length } },
]);
