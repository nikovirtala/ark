import { defineKind, type Kind } from "@nikovirtala/ledger";
import {
  type DecisionView,
  formatDecisionNumber,
  parseDecisionNumber,
  project,
} from "./kind/project.js";
import { type DecisionState, reduce } from "./kind/reduce.js";
import { type AdrOptions, invariants, relate } from "./kind/rules.js";
import { type DecisionEvents, type DecisionStatus, decisionEvents } from "./kind/schemas.js";

export type { DecisionView } from "./kind/project.js";
export { formatDecisionNumber, parseDecisionNumber } from "./kind/project.js";
export type { DecisionState } from "./kind/reduce.js";
export type { AdrOptions } from "./kind/rules.js";
export {
  DECISION_STATUSES,
  type DecisionEvents,
  type DecisionStatus,
  type LinkRel,
  REF,
} from "./kind/schemas.js";

/**
 * The decision kind (01:128–194), as imported by other tools through `@nikovirtala/adr/kind`.
 *
 * Decisions are proposed, then accepted (which freezes the body and earns a number on main),
 * rejected or withdrawn; accepted ones can be deprecated or superseded. This module imports only
 * `@nikovirtala/ledger` and `./kind/*`, so importing the kind never loads CLI or MCP code.
 */
export const adrKind: Kind<
  DecisionStatus,
  DecisionEvents,
  DecisionState,
  DecisionView,
  AdrOptions
> = defineKind<DecisionStatus, DecisionEvents, DecisionState, DecisionView, AdrOptions>({
  name: "decision",
  schema: "decision/v1",
  states: ["proposed", "accepted", "rejected", "withdrawn", "deprecated", "superseded"],
  events: decisionEvents,
  initial: "proposed",
  reduce,
  invariants,
  relate,
  project,
  body: { freezeOn: "accepted" },
  layout: { bodies: "decisions", events: "events" },
  defaultRoot: "docs/adr",
  sourceName: "adr",
  numbering: { on: "accepted", format: formatDecisionNumber, parse: parseDecisionNumber },
  templates: {
    dir: "templates",
    nameField: "template",
    versionField: "template_version",
    lintIn: ["proposed"],
    lintOn: "accepted",
    requireSections: ["scope"],
  },
  scope: { event: "scoped", activeIn: ["proposed", "accepted", "deprecated"] },
  options: Object.freeze({ acceptRequiresHuman: true }),
});
