import type { EventDefs, StateMachine } from "./types.js";

/**
 * Builds the state machine of validated event definitions: `allowedIn` and `to` per type, in
 * definition order. `defineKind` checks the definitions first.
 */
export function buildMachine<S extends string>(o: {
  readonly states: readonly S[];
  readonly events: EventDefs<S>;
  readonly initial: { readonly type: string; readonly to: S };
}): StateMachine<S> {
  const types = new Map(
    Object.entries(o.events).map(([type, e]) => [
      type,
      Object.freeze({ allowedIn: e.allowedIn, to: e.to, reason: e.reason ?? "optional" }),
    ]),
  );
  const allowed = (status: S, type: string): boolean => {
    const t = types.get(type);
    return t !== undefined && (t.allowedIn === "any" || t.allowedIn.includes(status));
  };
  const changing = [...types].filter(([, t]) => t.to !== null).map(([type]) => type);
  return Object.freeze({
    states: Object.freeze([...o.states]),
    initial: Object.freeze({ ...o.initial }),
    types,
    terminal: Object.freeze(o.states.filter((s) => !changing.some((type) => allowed(s, type)))),
    allowed,
    next: (status: S) => Object.freeze([...types.keys()].filter((type) => allowed(status, type))),
  });
}
