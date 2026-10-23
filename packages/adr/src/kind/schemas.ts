import { eventType, setEventType } from "@nikovirtala/ledger";

/** A decision's computed status. */
export type DecisionStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "withdrawn"
  | "deprecated"
  | "superseded";

/** Every status, in lifecycle order. */
export const DECISION_STATUSES: readonly DecisionStatus[] = Object.freeze([
  "proposed",
  "accepted",
  "rejected",
  "withdrawn",
  "deprecated",
  "superseded",
]);

/** A local subject id, or a qualified `<source>:<id>` one. */
export const REF = "^(?:[a-z][a-z0-9-]*:)?[0-9a-hjkmnp-tv-z]{8}$";

const ref = { type: "string", pattern: REF } as const;
const SINGLE_LINE = "^[^\\r\\n]*$";

/** How a `linked` decision relates to its target. */
export type LinkRel = "relates-to" | "refines" | "depends-on";

/** The decision kind's event types (01:128–136): data schemas, allowed states and targets. */
export const decisionEvents = {
  proposed: eventType<{
    title: string;
    template: string;
    template_version: number;
    supersedes?: string[];
  }>()({
    data: {
      type: "object",
      required: ["title", "template", "template_version"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200, pattern: SINGLE_LINE },
        template: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
        template_version: { type: "integer", minimum: 1 },
        supersedes: { type: "array", items: ref, uniqueItems: true, maxItems: 20 },
      },
    },
    allowedIn: [],
    to: "proposed",
  }),
  accepted: eventType<{ body_sha256: string }>()({
    data: {
      type: "object",
      required: ["body_sha256"],
      properties: { body_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" } },
    },
    allowedIn: ["proposed"],
    to: "accepted",
  }),
  rejected: eventType()({
    data: { type: "object" },
    allowedIn: ["proposed"],
    to: "rejected",
    reason: "required",
  }),
  withdrawn: eventType()({ data: { type: "object" }, allowedIn: ["proposed"], to: "withdrawn" }),
  deprecated: eventType()({
    data: { type: "object" },
    allowedIn: ["accepted"],
    to: "deprecated",
    reason: "required",
  }),
  superseded: eventType<{ by: string }>()({
    data: { type: "object", required: ["by"], properties: { by: ref } },
    allowedIn: ["accepted", "deprecated"],
    to: "superseded",
  }),
  noted: eventType<{ text: string }>()({
    data: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string", minLength: 1 } },
    },
    allowedIn: "any",
    to: null,
  }),
  linked: eventType<{ to: string; rel: LinkRel }>()({
    data: {
      type: "object",
      required: ["to", "rel"],
      properties: { to: ref, rel: { enum: ["relates-to", "refines", "depends-on"] } },
    },
    allowedIn: "any",
    to: null,
  }),
  // ledger's whole-set event (G11): the same schema as before, so decision/v1 is unchanged.
  scoped: setEventType({
    item: { type: "string", minLength: 1, maxLength: 500 },
    maxItems: 200,
    allowedIn: ["proposed", "accepted", "deprecated"],
  }),
} as const;

export type DecisionEvents = typeof decisionEvents;
