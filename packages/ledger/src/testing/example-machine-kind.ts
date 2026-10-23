import { defineKind, eventType } from "../kind/define.js";

/** The reduced state of an `exampleMachineKind` widget. */
export interface WidgetState {
  readonly title: string;
  /** `noted` events applied. */
  readonly notes: number;
  /** `revived` events applied. */
  readonly revivals: number;
}

/** The projection of an `exampleMachineKind` widget. */
export interface WidgetView {
  readonly id: string;
  readonly display: string;
  readonly status: string;
  readonly title: string;
  readonly notes: number;
  readonly revivals: number;
}

/**
 * A kind with a state machine, for tests. Widgets are `created` as drafts, `published` (which
 * freezes the body), `retired` (with a reason) and `revived` back to published; `noted` is allowed
 * in any state and changes nothing. Published widgets are numbered `W-<n>`.
 */
export const exampleMachineKind = defineKind({
  name: "widget",
  schema: "widget/v1",
  states: ["draft", "published", "retired"],
  events: {
    created: eventType<{ title: string }>()({
      data: {
        type: "object",
        required: ["title"],
        properties: { title: { type: "string", minLength: 1 } },
      },
      allowedIn: [],
      to: "draft",
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
    published: eventType<{ body_sha256: string }>()({
      data: {
        type: "object",
        required: ["body_sha256"],
        properties: { body_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" } },
      },
      allowedIn: ["draft"],
      to: "published",
    }),
    retired: eventType()({
      data: { type: "object" },
      allowedIn: ["published"],
      to: "retired",
      reason: "required",
    }),
    revived: eventType()({ data: { type: "object" }, allowedIn: ["retired"], to: "published" }),
  },
  initial: "created",
  reduce: (state: WidgetState | null, e): WidgetState => {
    const s = state ?? { title: "", notes: 0, revivals: 0 };
    switch (e.type) {
      case "created":
        return { ...s, title: e.data.title };
      case "noted":
        return { ...s, notes: s.notes + 1 };
      case "revived":
        return { ...s, revivals: s.revivals + 1 };
      default:
        return s;
    }
  },
  project: (s, ctx): WidgetView => ({
    id: s.id,
    display: ctx.display(s.id),
    status: s.status ?? "",
    title: s.state?.title ?? "",
    notes: s.state?.notes ?? 0,
    revivals: s.state?.revivals ?? 0,
  }),
  body: { freezeOn: "published" },
  layout: { bodies: "items", events: "events" },
  defaultRoot: "log",
  numbering: {
    on: "published",
    format: (n) => `W-${n}`,
    parse: (input) => {
      const m = /^(?:w-)?0*([1-9][0-9]{0,8})$/i.exec(input.trim());
      return m === null ? null : Number(m[1]);
    },
  },
  options: undefined,
});
