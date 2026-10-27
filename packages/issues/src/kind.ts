import { defineKind, type Kind } from "@nikovirtala/ledger";
import { formatIssueNumber, type IssueView, parseIssueNumber, project } from "./kind/project.js";
import { type IssueState, reduce } from "./kind/reduce.js";
import { DEFAULT_ISSUE_OPTIONS, type IssueOptions, invariants, relate } from "./kind/rules.js";
import { type IssueEvents, type IssueStatus, issueEvents } from "./kind/schemas.js";

export {
  type DerivedFields,
  type GraphCycle,
  type GraphEdge,
  type IssueGraph,
  issueGraph,
} from "./kind/graph.js";
export { formatIssueNumber, type IssueView, parseIssueNumber } from "./kind/project.js";
export type { IssueLink, IssueState } from "./kind/reduce.js";
export {
  DEFAULT_ISSUE_OPTIONS,
  type ForeignSubject,
  type IssueOptions,
  labelPrefix,
  type SourceLog,
} from "./kind/rules.js";
export {
  ISSUE_REF,
  ISSUE_STATES,
  type IssueEvents,
  type IssueStatus,
  LABEL,
  LOCAL_ID,
  RELS,
  RESOLUTIONS,
  type Rel,
  type Resolution,
} from "./kind/schemas.js";

/**
 * The issue kind (02 Event schema, State machine and invariants), as imported by other tools
 * through `@nikovirtala/issues/kind`.
 *
 * Issues are opened, started and stopped, closed with a resolution and reopened; no state is
 * terminal. Relations between issues, and `implements` links into decision logs, are folded here
 * until shared relation code moves into ledger. This module imports only `@nikovirtala/ledger`
 * and `./kind/*`, so importing the kind never loads CLI or MCP code.
 */
export const issueKind: Kind<IssueStatus, IssueEvents, IssueState, IssueView, IssueOptions> =
  defineKind<IssueStatus, IssueEvents, IssueState, IssueView, IssueOptions>({
    name: "issue",
    schema: "issue/v1",
    states: ["open", "in-progress", "closed"],
    events: issueEvents,
    initial: "opened",
    reduce,
    invariants,
    relate,
    project,
    // ledger leaves the body to git; verify still requires the file.
    body: "mutable",
    layout: { bodies: "items", events: "events" },
    defaultRoot: "docs/issues",
    sourceName: "issues",
    numbering: { on: "opened", format: formatIssueNumber, parse: parseIssueNumber },
    templates: {
      dir: "templates",
      nameField: "template",
      versionField: "template_version",
      lintIn: ["open", "in-progress"],
      requireSections: ["done"],
    },
    // An open issue's globs may name code that doesn't exist yet (?7): only in-progress issues'
    // globs must match a tracked file.
    scope: {
      event: "scoped",
      activeIn: ["open", "in-progress"],
      requireMatchIn: ["in-progress"],
      keyword: "issue",
    },
    options: DEFAULT_ISSUE_OPTIONS,
  });
