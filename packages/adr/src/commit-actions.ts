/**
 * `{action}` of a commit that writes one event of each type (design §4.3), and what the title slot
 * names: the decision's title for the events that change whether it is decided, else its display.
 */
export const ACTIONS = {
  proposed: { action: "propose to", names: "title" },
  accepted: { action: "decide to", names: "title" },
  rejected: { action: "decide not to", names: "title" },
  withdrawn: { action: "withdraw the proposal to", names: "title" },
  deprecated: { action: "deprecate", names: "display" },
  superseded: { action: "supersede", names: "display" },
  noted: { action: "add a note to", names: "display" },
  linked: { action: "link", names: "display" },
  scoped: { action: "set the scope of", names: "display" },
} as const satisfies Record<string, { action: string; names: "title" | "display" }>;

/**
 * The verb of each display-named event type in a batch subject (?6, design §4.4), and the order
 * they are joined in: `link and scope ADR-0003`, `add a note to` last so it reads before the name.
 */
export const BATCH_ACTIONS = {
  deprecated: "deprecate",
  superseded: "supersede",
  linked: "link",
  scoped: "scope",
  noted: "add a note to",
} as const;
export const BATCH_ORDER: readonly string[] = [
  "deprecated",
  "superseded",
  "linked",
  "scoped",
  "noted",
];

/** `{action}` of a batch of more than three verbs. */
export const UPDATE_ACTION = "update";

/** The longest batch action, `deprecate, supersede and add a note to`. */
export const LONGEST_BATCH = "deprecate, supersede and add a note to".length;

/** `{action}` of `adr index --commit`, whose title slot holds `the decision index`. */
export const INDEX_ACTION = "regenerate";

/** What `adr index --commit`'s title slot holds. */
export const INDEX_TITLE = "the decision index";

/** `{action}` of a draft update (`adr_update_draft`), whose title slot holds the display. */
export const DRAFT_ACTION = "update the draft of";

/**
 * The longest `{action}` that goes with a title, which `[commit] subject` must leave a title room
 * for. A batch action (up to `LONGEST_BATCH`) only ever goes with a display, so `COMMIT_NAMES`
 * covers it instead.
 */
export const LONGEST_ACTION: number = Math.max(
  ...Object.values(ACTIONS).map((a) => a.action.length),
  INDEX_ACTION.length,
  DRAFT_ACTION.length,
);

/** The longest display: `ADR-` and up to 9 digits (`formatDecisionNumber`, kind/project.ts). */
export const DISPLAY_LENGTH = 13;

/** What a link's title slot names after the display when the target is in another log. */
export const CROSS_LOG_LINK = "to a decision in another log";

/** adr's commit-subject placeholders, each with its longest value (design §4.2). */
export const COMMIT_VARS = Object.freeze({
  action: LONGEST_ACTION,
  id: 8,
  display: DISPLAY_LENGTH,
  command: 9,
});

/**
 * The names the title placeholder holds instead of a title, which are never shortened, each with
 * its action: supersede's `<display> with <display>` and a link's `<display> to <display>` or
 * `<display> to a decision in another log` (`planLink` in write.ts), and `adr index`'s
 * `the decision index`. The shorter names (a display, at most 13 characters) always fit in the
 * room a title gets.
 */
export const COMMIT_NAMES = Object.freeze([
  {
    length: DISPLAY_LENGTH * 2 + " with ".length,
    vars: { action: ACTIONS.superseded.action.length },
  },
  {
    length: DISPLAY_LENGTH + 1 + CROSS_LOG_LINK.length,
    vars: { action: ACTIONS.linked.action.length },
  },
  { length: INDEX_TITLE.length, vars: { action: INDEX_ACTION.length } },
  // A batch names the decision by its display, never shortened; where the joined verbs don't fit
  // the template, the batch says `update <display>`, so every template that fits that still parses.
  { length: DISPLAY_LENGTH, vars: { action: UPDATE_ACTION.length } },
]);
