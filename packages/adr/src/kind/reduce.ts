import type { Actor, FoldEvent } from "@nikovirtala/ledger";
import type { DecisionEvents } from "./schemas.js";

/** A decision's own state, maintained by `reduce` over its applied events. */
export interface DecisionState {
  readonly title: string;
  readonly template: { readonly name: string; readonly version: number };
  readonly declaredSupersedes: readonly string[];
  /** From the applied `accepted` event. */
  readonly bodySha256: string | null;
  readonly acceptedBy: Actor | null;
  readonly supersededBy: string | null;
  /** In fold order, duplicates kept once. */
  readonly links: readonly { readonly to: string; readonly rel: string }[];
  /** The latest `scoped` set (latest wins). */
  readonly appliesTo: readonly string[];
  readonly notes: number;
  /** State-changing events only, in fold order. */
  readonly history: readonly { readonly type: string; readonly at: string }[];
  readonly proposedAt: string;
  /** `at` of `accepted`, `rejected` or `withdrawn`. */
  readonly decidedAt: string | null;
  /** `at` of the latest state-changing event. */
  readonly statusAt: string;
}

const EMPTY: DecisionState = {
  title: "",
  template: { name: "", version: 0 },
  declaredSupersedes: [],
  bodySha256: null,
  acceptedBy: null,
  supersededBy: null,
  links: [],
  appliesTo: [],
  notes: 0,
  history: [],
  proposedAt: "",
  decidedAt: null,
  statusAt: "",
};

/** Pure: the state after one applied event. The fold only passes events the machine allows. */
export function reduce(state: DecisionState | null, e: FoldEvent<DecisionEvents>): DecisionState {
  const s = state ?? EMPTY;
  const changed = (extra: Partial<DecisionState> = {}): DecisionState => ({
    ...s,
    ...extra,
    history: [...s.history, { type: e.type, at: e.at }],
    statusAt: e.at,
  });
  switch (e.type) {
    case "proposed":
      return changed({
        title: e.data.title,
        template: { name: e.data.template, version: e.data.template_version },
        declaredSupersedes: [...(e.data.supersedes ?? [])],
        proposedAt: e.at,
      });
    case "accepted":
      return changed({ bodySha256: e.data.body_sha256, acceptedBy: e.actor, decidedAt: e.at });
    case "rejected":
    case "withdrawn":
      return changed({ decidedAt: e.at });
    case "deprecated":
      return changed();
    case "superseded":
      return changed({ supersededBy: e.data.by });
    case "noted":
      return { ...s, notes: s.notes + 1 };
    case "linked": {
      const { to, rel } = e.data;
      const known = s.links.some((l) => l.to === to && l.rel === rel);
      return known ? s : { ...s, links: [...s.links, { to, rel }] };
    }
    case "scoped":
      return { ...s, appliesTo: [...e.data.set] };
  }
}
