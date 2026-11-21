/**
 * A run as a state machine, as data: the phases, the events that move a run between them, and the
 * effects each transition has, in the order they happen. `orchestrate()` walks it; the property tests
 * check it. The rules it encodes:
 *
 *  - a frozen flag at the start ends the run in `frozen` with no effect at all;
 *  - a refusal before `deploying` only notifies: nothing is deployed, nothing is frozen;
 *  - a failed deploy or smoke sets the freeze flag FIRST, then rolls back, then notifies;
 *  - a failed task sets the freeze flag and notifies, and never rolls back;
 *  - there is no transition out of `frozen`, `refused` or `succeeded`: only a person clears the flag,
 *    outside any run.
 */
import type { RunPhase, TerminalPhase } from "./records.js";

export type RunEvent =
  | "found-frozen"
  | "start"
  | "refuse"
  | "checked"
  | "deploy-failed"
  | "deployed"
  | "smoke-failed"
  | "smoke-passed"
  | "task-failed"
  | "tasks-passed";

export type Effect = "set-freeze" | "roll-back" | "notify" | "record-last-good";

export interface Transition {
  readonly from: RunPhase;
  readonly on: RunEvent;
  readonly to: RunPhase;
  readonly effects: readonly Effect[];
}

export const TERMINAL_PHASES: ReadonlySet<RunPhase> = new Set<TerminalPhase>([
  "succeeded",
  "refused",
  "frozen",
]);

export const TRANSITIONS: readonly Transition[] = [
  { from: "queued", on: "found-frozen", to: "frozen", effects: [] },
  { from: "queued", on: "start", to: "preflight", effects: [] },
  { from: "preflight", on: "refuse", to: "refused", effects: ["notify"] },
  { from: "preflight", on: "checked", to: "deploying", effects: [] },
  {
    from: "deploying",
    on: "deploy-failed",
    to: "frozen",
    effects: ["set-freeze", "roll-back", "notify"],
  },
  { from: "deploying", on: "deployed", to: "smoking", effects: [] },
  {
    from: "smoking",
    on: "smoke-failed",
    to: "frozen",
    effects: ["set-freeze", "roll-back", "notify"],
  },
  { from: "smoking", on: "smoke-passed", to: "running-tasks", effects: [] },
  { from: "running-tasks", on: "task-failed", to: "frozen", effects: ["set-freeze", "notify"] },
  { from: "running-tasks", on: "tasks-passed", to: "succeeded", effects: ["record-last-good"] },
];

export class IllegalTransitionError extends Error {
  constructor(from: RunPhase, on: RunEvent) {
    super(`a run in ${from} has no transition on ${on}`);
    this.name = "IllegalTransitionError";
  }
}

/** The transition for an event in a phase. Throws for an event the phase does not take. */
export function transition(from: RunPhase, on: RunEvent): Transition {
  const t = TRANSITIONS.find((x) => x.from === from && x.on === on);
  if (!t) throw new IllegalTransitionError(from, on);
  return t;
}

/** The events a phase takes: none for a terminal phase. */
export function eventsFrom(phase: RunPhase): RunEvent[] {
  return TRANSITIONS.filter((t) => t.from === phase).map((t) => t.on);
}

/** One run's walk through the machine, recording every transition it took. */
export class RunMachine {
  private current: RunPhase = "queued";
  readonly taken: Transition[] = [];

  get phase(): RunPhase {
    return this.current;
  }

  fire(on: RunEvent): Transition {
    const t = transition(this.current, on);
    this.current = t.to;
    this.taken.push(t);
    return t;
  }

  /** The phases the run went through, from `queued`. */
  path(): RunPhase[] {
    return ["queued", ...this.taken.map((t) => t.to)];
  }
}
