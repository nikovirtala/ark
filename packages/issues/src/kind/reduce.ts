import type { Actor, FoldEvent } from "@nikovirtala/ledger";
import type { IssueEvents, Rel, Resolution } from "./schemas.js";

/** One current relation of an issue. */
export interface IssueLink {
  readonly to: string;
  readonly rel: Rel;
  /**
   * The event that made the link current: the first applied `linked` of this `(to, rel)` since it
   * was last absent, or the `opened` event for `opened.parent`.
   */
  readonly event: string;
}

/** An issue's own state, maintained by `reduce` over its applied events. */
export interface IssueState {
  /** `opened.data.title`; the view's title follows the body's heading. */
  readonly title: string;
  readonly template: { readonly name: string; readonly version: number };
  /** Of the current `closed` state; `null` while open or in progress. */
  readonly resolution: Resolution | null;
  /** The current `closed.of`, only when closed as a duplicate. */
  readonly duplicateOf: string | null;
  readonly closedBy: Actor | null;
  /** Current links in fold order, each `(to, rel)` once. */
  readonly links: readonly IssueLink[];
  /** The latest `assigned` set. */
  readonly assignees: readonly string[];
  /** The latest `labeled` set. */
  readonly labels: readonly string[];
  /** The latest `scoped` set. */
  readonly appliesTo: readonly string[];
  readonly comments: number;
  /** State-changing events only, in fold order. */
  readonly history: readonly { readonly type: string; readonly at: string }[];
  readonly openedAt: string;
  readonly closedAt: string | null;
  /** `at` of the latest state-changing event. */
  readonly stateAt: string;
}

const EMPTY: IssueState = {
  title: "",
  template: { name: "", version: 0 },
  resolution: null,
  duplicateOf: null,
  closedBy: null,
  links: [],
  assignees: [],
  labels: [],
  appliesTo: [],
  comments: 0,
  history: [],
  openedAt: "",
  closedAt: null,
  stateAt: "",
};

/** Pure: the state after one applied event. The fold only passes events the machine allows. */
export function reduce(state: IssueState | null, e: FoldEvent<IssueEvents>): IssueState {
  const s = state ?? EMPTY;
  const changed = (extra: Partial<IssueState> = {}): IssueState => ({
    ...s,
    ...extra,
    history: [...s.history, { type: e.type, at: e.at }],
    stateAt: e.at,
  });
  switch (e.type) {
    case "opened": {
      const parent = e.data.parent;
      return changed({
        title: e.data.title,
        template: { name: e.data.template, version: e.data.template_version },
        links: parent === undefined ? [] : [{ to: parent, rel: "part-of" as const, event: e.id }],
        openedAt: e.at,
      });
    }
    case "started":
    case "stopped":
      return changed();
    case "closed":
      return changed({
        resolution: e.data.resolution,
        duplicateOf: e.data.resolution === "duplicate" ? (e.data.of ?? null) : null,
        closedBy: e.actor,
        closedAt: e.at,
      });
    case "reopened":
      return changed({ resolution: null, duplicateOf: null, closedBy: null, closedAt: null });
    case "assigned":
      return { ...s, assignees: [...e.data.set] };
    case "labeled":
      return { ...s, labels: [...e.data.set] };
    case "scoped":
      return { ...s, appliesTo: [...e.data.set] };
    case "commented":
      return { ...s, comments: s.comments + 1 };
    case "linked": {
      const { to, rel } = e.data;
      const known = s.links.some((l) => l.to === to && l.rel === rel);
      return known ? s : { ...s, links: [...s.links, { to, rel, event: e.id }] };
    }
    case "unlinked": {
      const { to, rel } = e.data;
      const links = s.links.filter((l) => !(l.to === to && l.rel === rel));
      return links.length === s.links.length ? s : { ...s, links };
    }
  }
}
