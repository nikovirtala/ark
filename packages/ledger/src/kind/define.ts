import { compileKind, type EventTypeSchema, type KindSchema } from "../envelope/kind.js";
import { KindDefinitionError } from "../errors.js";
import { normalizeLayout } from "../identity/layout.js";
import { buildMachine } from "./machine.js";
import type { AnyKind, DATA, EventDefs, EventTypeDef, Kind, KindDef } from "./types.js";

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const BRAND = Symbol.for("@nikovirtala/ledger/kind");
/** A comment-anchor keyword, as `[[sources]].name`. */
const KEYWORD = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Typed constructor: `eventType<{ by: string }>()({ data, allowedIn, to })`. The states are
 * inferred from `allowedIn` and `to` separately, so `allowedIn: "any", to: null` names none.
 */
export function eventType<D extends object = Record<string, never>>(): <
  const A extends string = never,
  const T extends string | null = null,
>(
  def: Omit<EventTypeDef<A, D>, typeof DATA | "to"> & { readonly to: T },
) => EventTypeDef<A | NonNullable<T>, D> {
  return (def) => def;
}

/** Whether `k` was returned by `defineKind`. */
export function isKind(k: KindSchema): k is AnyKind {
  return Object.hasOwn(k, BRAND);
}

/** The first problem with a definition's states, event types, references and schema key. */
function definitionProblem<S extends string, E extends EventDefs<S>, St, P, O>(
  def: KindDef<S, E, St, P, O>,
): string | null {
  const states = new Set<string>(def.states);
  const isState = (s: string) => states.has(s);
  const events = Object.entries(def.events);
  const isType = (t: unknown) => typeof t === "string" && Object.hasOwn(def.events, t);
  const list = (xs: readonly string[]) => xs.map((x) => JSON.stringify(x)).join(", ");

  if (def.states.length === 0) return "states must not be empty";
  if (states.size !== def.states.length) {
    const dup = def.states.find((s, i) => def.states.indexOf(s) !== i) ?? "";
    return `state ${JSON.stringify(dup)} is listed twice`;
  }
  const badState = def.states.find((s) => typeof s !== "string" || s.length > 64 || !NAME.test(s));
  if (badState !== undefined) return `invalid state name ${JSON.stringify(badState)}`;

  for (const [type, e] of events) {
    const where = `event type ${JSON.stringify(type)}`;
    if (e.allowedIn !== "any") {
      if (!Array.isArray(e.allowedIn)) {
        return `${where}: allowedIn must be "any" or a list of states`;
      }
      const unknown = e.allowedIn.filter((s) => !isState(s));
      if (unknown.length > 0) return `${where}: allowedIn names unknown state ${list(unknown)}`;
    }
    if (e.to !== null && !isState(e.to)) {
      return `${where}: to names unknown state ${JSON.stringify(e.to)}`;
    }
  }

  const initial = isType(def.initial) ? def.events[def.initial] : undefined;
  if (initial === undefined) {
    return `initial type ${JSON.stringify(def.initial)} is not an event type`;
  }
  if (initial.to === null) return `initial type ${JSON.stringify(def.initial)} must change state`;
  if (!Array.isArray(initial.allowedIn) || initial.allowedIn.length !== 0) {
    return `initial type ${JSON.stringify(def.initial)} must have allowedIn: [] (first event only)`;
  }
  for (const [type, e] of events) {
    if (type !== def.initial && Array.isArray(e.allowedIn) && e.allowedIn.length === 0) {
      return `event type ${JSON.stringify(type)}: allowedIn is empty, so it could never be applied`;
    }
  }

  if (typeof def.body === "object") {
    const freeze = isType(def.body.freezeOn) ? def.events[def.body.freezeOn] : undefined;
    if (freeze === undefined) {
      return `freezeOn type ${JSON.stringify(def.body.freezeOn)} is not an event type`;
    }
    if (freeze.to === null) {
      return `freezeOn type ${JSON.stringify(def.body.freezeOn)} must change state`;
    }
  }
  const refs: [string, unknown][] = [
    ["numbering.on", def.numbering?.on],
    ["templates.lintOn", def.templates?.lintOn],
    ["scope.event", def.scope?.event],
  ];
  for (const [field, t] of refs) {
    if (t !== undefined && !isType(t)) return `${field} ${JSON.stringify(t)} is not an event type`;
  }
  const stateRefs: [string, readonly string[] | undefined][] = [
    ["templates.lintIn", def.templates?.lintIn],
    ["scope.activeIn", def.scope?.activeIn],
  ];
  for (const [field, ss] of stateRefs) {
    const unknown = (ss ?? []).filter((s) => !isState(s));
    if (unknown.length > 0) return `${field} names unknown state ${list(unknown)}`;
  }
  if (def.scope !== undefined) {
    const { keyword, event } = def.scope;
    if (keyword !== undefined && (typeof keyword !== "string" || !KEYWORD.test(keyword))) {
      return `scope.keyword ${JSON.stringify(keyword)} must match ${KEYWORD.source}`;
    }
    const data = def.events[event]?.data as
      | { readonly properties?: { readonly set?: { readonly type?: unknown } } }
      | undefined;
    if (data?.properties?.set?.type !== "array") {
      return `scope.event ${JSON.stringify(event)} must have a data.set array`;
    }
  }

  const prefix = `${def.name}/v`;
  const version = def.schema.startsWith(prefix) ? def.schema.slice(prefix.length) : "";
  if (!/^[1-9][0-9]*$/.test(version)) {
    return `schema ${JSON.stringify(def.schema)} must be "${def.name}/v<n>"`;
  }
  if (def.previousSchemas !== undefined && Object.hasOwn(def.previousSchemas, def.schema)) {
    return `schema ${JSON.stringify(def.schema)} is also listed in previousSchemas`;
  }
  if ((def.layout.bodies === null) !== (def.body === "none")) {
    return def.body === "none"
      ? 'layout.bodies must be null when body is "none"'
      : 'layout.bodies must be set when body is not "none"';
  }
  return null;
}

/**
 * Turns a kind definition into a `Kind`: a `KindSchema` whose current data-schema version is
 * `def.schema`, plus the state machine. Throws `KindDefinitionError` for an invalid definition,
 * including the data-schema errors `compileKind` finds.
 */
export function defineKind<
  const S extends string,
  const E extends EventDefs<S>,
  St,
  P,
  O = undefined,
>(def: KindDef<S, E, St, P, O>): Kind<S, E, St, P, O> {
  const name = String(def.name);
  const problem = definitionProblem(def);
  if (problem !== null) throw new KindDefinitionError(name, `kind ${name}: ${problem}`);
  try {
    normalizeLayout({ root: def.defaultRoot, ...def.layout });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new KindDefinitionError(name, `kind ${name}: defaultRoot ${why}`, { cause: e });
  }

  const current: Record<string, EventTypeSchema> = {};
  for (const [type, e] of Object.entries(def.events)) {
    current[type] = { data: e.data, reason: e.reason ?? "optional" };
  }
  const initial = def.events[def.initial];
  const kind = {
    name: def.name,
    schemas: Object.freeze({ ...def.previousSchemas, [def.schema]: { events: current } }),
    body: def.body,
    def,
    machine: buildMachine({
      states: def.states,
      events: def.events,
      initial: { type: def.initial, to: initial?.to as S },
    }),
    schema: def.schema,
    sourceName: def.sourceName ?? def.name,
    anchorKeyword: def.scope?.keyword ?? def.sourceName ?? def.name,
    layoutAt: (root: string) => normalizeLayout({ root, ...def.layout }),
  } satisfies Kind<S, E, St, P, O>;
  Object.defineProperty(kind, BRAND, { value: true });
  Object.freeze(kind);
  compileKind(kind);
  return kind;
}
