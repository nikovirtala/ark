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

/** The longest `{action}`, which `[commit] subject` must leave room for. */
export const LONGEST_ACTION: number = Math.max(
  ...Object.values(ACTIONS).map((a) => a.action.length),
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
 * `<display> to a decision in another log` (`planLink` in write.ts). The shorter names (a display,
 * at most 13 characters) always fit in the room a title gets.
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
]);
