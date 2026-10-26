import { eventType, setEventType } from "@nikovirtala/ledger";

/** An issue's computed state. */
export type IssueStatus = "open" | "in-progress" | "closed";

/** Every state, in lifecycle order. */
export const ISSUE_STATES: readonly IssueStatus[] = Object.freeze([
  "open",
  "in-progress",
  "closed",
]);

/** How a `closed` issue was closed. */
export type Resolution = "done" | "wontfix" | "duplicate" | "obsolete";

/** Every resolution; `done` is the default. */
export const RESOLUTIONS: readonly Resolution[] = Object.freeze([
  "done",
  "wontfix",
  "duplicate",
  "obsolete",
]);

/** How a `linked` issue relates to its target. */
export type Rel = "depends-on" | "part-of" | "relates-to" | "implements";

/** Every relation, in the order the CLI lists them. */
export const RELS: readonly Rel[] = Object.freeze([
  "depends-on",
  "part-of",
  "relates-to",
  "implements",
]);

/** A subject id of this log. */
export const LOCAL_ID = "^[0-9a-hjkmnp-tv-z]{8}$";

/** A local subject id, or a qualified `<source>:<id>` one (ledger's `parseQualifiedId` form). */
export const ISSUE_REF = "^(?:[a-z][a-z0-9-]{0,31}:)?[0-9a-hjkmnp-tv-z]{8}$";

/** A label: `name` or `prefix:name`; the prefix is what `[labels] exclusive` names. */
export const LABEL = "^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}(?::[A-Za-z0-9][A-Za-z0-9._/-]{0,63})?$";

/** An assignee: an email address or a name, without whitespace or commas. */
export const ASSIGNEE = "^[^\\s,]{1,254}$";

const SINGLE_LINE = "^[^\\r\\n]*$";
const ref = { type: "string", pattern: ISSUE_REF } as const;
const rel = { enum: [...RELS] } as const;

/** The issue kind's event types (02 Event schema): data schemas, allowed states and targets. */
export const issueEvents = {
  opened: eventType<{
    title: string;
    template: string;
    template_version: number;
    parent?: string;
  }>()({
    data: {
      type: "object",
      required: ["title", "template", "template_version"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200, pattern: SINGLE_LINE },
        template: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
        template_version: { type: "integer", minimum: 1 },
        parent: ref,
      },
    },
    allowedIn: [],
    to: "open",
  }),
  started: eventType()({ data: { type: "object" }, allowedIn: ["open"], to: "in-progress" }),
  stopped: eventType()({ data: { type: "object" }, allowedIn: ["in-progress"], to: "open" }),
  closed: eventType<{ resolution: Resolution; of?: string }>()({
    data: {
      type: "object",
      required: ["resolution"],
      properties: { resolution: { enum: [...RESOLUTIONS] } },
      // ajv's strict mode refuses a `then.required` whose property `then` doesn't declare.
      if: { properties: { resolution: { const: "duplicate" } } },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema's if/then, never awaited
      then: { required: ["of"], properties: { of: { type: "string", pattern: LOCAL_ID } } },
    },
    allowedIn: ["open", "in-progress"],
    to: "closed",
  }),
  reopened: eventType()({
    data: { type: "object" },
    allowedIn: ["closed"],
    to: "open",
    reason: "required",
  }),
  assigned: setEventType<IssueStatus>({
    item: { type: "string", pattern: ASSIGNEE },
    maxItems: 20,
    allowedIn: "any",
  }),
  labeled: setEventType<IssueStatus>({
    item: { type: "string", pattern: LABEL },
    maxItems: 50,
    allowedIn: "any",
  }),
  commented: eventType<{ text: string }>()({
    data: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string", minLength: 1 } },
    },
    allowedIn: "any",
    to: null,
  }),
  linked: eventType<{ to: string; rel: Rel }>()({
    data: { type: "object", required: ["to", "rel"], properties: { to: ref, rel } },
    allowedIn: "any",
    to: null,
  }),
  unlinked: eventType<{ to: string; rel: Rel }>()({
    data: { type: "object", required: ["to", "rel"], properties: { to: ref, rel } },
    allowedIn: "any",
    to: null,
  }),
  scoped: setEventType<IssueStatus>({
    item: { type: "string", minLength: 1, maxLength: 500 },
    maxItems: 200,
    allowedIn: "any",
  }),
} as const;

export type IssueEvents = typeof issueEvents;
