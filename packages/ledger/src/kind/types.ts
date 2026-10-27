import type { BodyPolicy, KindSchema } from "../envelope/kind.js";
import type { EventEnvelope, JsonSchema } from "../envelope/types.js";
import type { Finding, Severity } from "../findings/finding.js";
import type { LogLayout } from "../identity/layout.js";
import type { LoadedSubject, LogSnapshot } from "../log/snapshot.js";

/** Phantom key carrying the TypeScript type of an event type's `data`; never present at runtime. */
export declare const DATA: unique symbol;

/** One event type, as data. */
export interface EventTypeDef<
  S extends string = string,
  D extends object = Record<string, unknown>,
> {
  /** JSON Schema (2020-12) of `data`; open at the top level (the `compileKind` rule). */
  readonly data: JsonSchema;
  /** States the event may be applied in. `[]` for the initial type: only as the first event. */
  readonly allowedIn: readonly S[] | "any";
  /** The state after the event; `null` when it doesn't change state. */
  readonly to: S | null;
  /** Default `"optional"`. `"required"`: a non-blank `reason` (after trim). */
  readonly reason?: "required" | "optional";
  /** Phantom: the TypeScript type of `data`. Never present at runtime. */
  readonly [DATA]?: D;
}

export type EventDefs<S extends string> = Readonly<Record<string, EventTypeDef<S, object>>>;

/** The `data` type an event type was declared with (`eventType<D>()`), else an open record. */
export type DataOf<T> = T extends { readonly [DATA]?: infer D extends object }
  ? unknown extends D
    ? Record<string, unknown>
    : D
  : Record<string, unknown>;

/** A valid event of one of the kind's types, with `data` typed by its `type`. */
export type FoldEvent<E extends EventDefs<string>> = {
  [T in keyof E & string]: EventEnvelope<DataOf<E[T]>> & { readonly type: T };
}[keyof E & string];

/** A finding as a kind reports it; ledger fills in the file and kind. */
export interface KindFinding {
  readonly severity: Severity;
  /** `<kind-area>/<name>`. */
  readonly rule: string;
  readonly message: string;
  readonly subject: string;
  /** Event id the finding is about; mapped to that event's file. */
  readonly event?: string;
  /** Other subjects involved; staged verify keeps a finding if any of them is in scope. */
  readonly related?: readonly string[];
}

/** An event the fold applied, with the status before and after it. */
export interface AppliedEvent<S extends string, E extends EventDefs<S>> {
  readonly event: FoldEvent<E>;
  readonly path: string;
  readonly from: S | null;
  readonly to: S;
}

/** One subject after replaying its valid events through the state machine. */
export interface FoldedSubject<S extends string, St, E extends EventDefs<S>> {
  readonly id: string;
  /** `null`: not folded (unreadable, no valid events, or first event not initial). */
  readonly status: S | null;
  readonly state: St | null;
  /** In fold order. */
  readonly applied: readonly AppliedEvent<S, E>[];
  readonly skipped: readonly {
    readonly path: string;
    readonly event: EventEnvelope;
    readonly rule: string;
  }[];
  /** `transition/*` findings; the file is the event's or the body's path. */
  readonly findings: readonly Finding[];
  readonly loaded: LoadedSubject;
}

export interface FoldedLog<S extends string, St, E extends EventDefs<S>> {
  readonly kind: Kind<S, E, St, unknown, unknown>;
  readonly snapshot: LogSnapshot;
  /** Sorted by id. */
  readonly subjects: ReadonlyMap<string, FoldedSubject<S, St, E>>;
}

/** What a kind's `project` can ask about the rest of the log. */
export interface ProjectContext<S extends string, St, E extends EventDefs<S>> {
  readonly log: FoldedLog<S, St, E>;
  /** Display number, only for subjects with an applied `numbering.on` event. */
  number(id: string): number | null;
  /** `format(number)`, or the id. */
  display(id: string): string;
  /** SHA-256 of the subject's current body bytes (`bodySha256`), or `null`. */
  bodySha256(id: string): string | null;
  /**
   * What the caller passed as `projectLog`'s `options` (for example other repositories' logs a
   * projection reads); `undefined` when it passed none. The kind narrows it.
   */
  readonly options?: unknown;
}

/**
 * A kind definition. The functions are declared as methods so a concrete kind is assignable to
 * `AnyKind`.
 */
export interface KindDef<S extends string, E extends EventDefs<S>, St, P, O> {
  /** The envelope `kind`. */
  readonly name: string;
  /** Data-schema version new events get, `<name>/v<n>`. */
  readonly schema: string;
  /** Older data-schema versions still read: key → per-type `data` and `reason`. */
  readonly previousSchemas?: KindSchema["schemas"];
  readonly states: readonly S[];
  readonly events: E;
  readonly initial: keyof E & string;
  /** Pure; must not throw for schema-valid events. */
  reduce(state: St | null, event: FoldEvent<E>): St;
  invariants?(subject: FoldedSubject<S, St, E>, options: O): readonly KindFinding[];
  relate?(log: FoldedLog<S, St, E>, options: O): readonly KindFinding[];
  project(subject: FoldedSubject<S, St, E>, ctx: ProjectContext<S, St, E>): P;
  readonly body: BodyPolicy;
  /** Directories relative to the log root. `bodies: null` iff `body === "none"`. */
  readonly layout: { readonly bodies: string | null; readonly events: string };
  /** Default log root in a repository and inside a source. */
  readonly defaultRoot: string;
  /** Default `[[sources]]` name and anchor keyword; default `name`. */
  readonly sourceName?: string;
  readonly numbering?: {
    readonly on: keyof E & string;
    /** adr: `ADR-0007`. */
    format(n: number): string;
    /** `"7"`, `"0007"`, `"ADR-7"` → 7; `null` when `input` isn't a number of this kind. */
    parse(input: string): number | null;
  };
  readonly templates?: {
    /** Relative to the log root. */
    readonly dir: string;
    /** Field of the initial event's data naming the template. */
    readonly nameField: string;
    readonly versionField: string;
    /** States whose bodies are linted against their template. */
    readonly lintIn: readonly S[];
    /** Also lint when this event is new in the diff. */
    readonly lintOn?: keyof E & string;
    readonly requireSections?: readonly string[];
  };
  /** Defaults for the `invariants`/`relate` options. */
  readonly options: O;
  /**
   * Scope: which whole-set event carries the glob set, in which states it is active, and the
   * comment-anchor keyword (`<keyword>:<id>`, default `sourceName`). `requireMatchIn` (a subset
   * of `activeIn`, default `activeIn`) are the states in which a glob matching no tracked file is
   * `scope/glob-unmatched`; leaving a planned state out lets planned work name code that doesn't
   * exist yet.
   */
  readonly scope?: {
    readonly event: keyof E & string;
    readonly activeIn: readonly S[];
    readonly requireMatchIn?: readonly S[];
    readonly keyword?: string;
  };
}

/** The state machine of a kind, derived from its event types. */
export interface StateMachine<S extends string> {
  readonly states: readonly S[];
  readonly initial: { readonly type: string; readonly to: S };
  readonly types: ReadonlyMap<
    string,
    {
      readonly allowedIn: readonly S[] | "any";
      readonly to: S | null;
      readonly reason: "required" | "optional";
    }
  >;
  /** States in which no state-changing type is allowed. */
  readonly terminal: readonly S[];
  allowed(status: S, type: string): boolean;
  /** Types applicable in `status`, in definition order. */
  next(status: S): readonly string[];
}

/**
 * A defined kind: a `KindSchema` (so `compileKind`, `loadLog` and `verifyLog` take it) plus its
 * definition and state machine.
 */
export interface Kind<S extends string, E extends EventDefs<S>, St, P, O> extends KindSchema {
  readonly def: KindDef<S, E, St, P, O>;
  readonly machine: StateMachine<S>;
  /** The data-schema version new events get. */
  readonly schema: string;
  readonly sourceName: string;
  /** The comment-anchor keyword: `scope.keyword`, else `sourceName`. */
  readonly anchorKeyword: string;
  /** `normalizeLayout({ root, ...def.layout })`. */
  layoutAt(root: string): LogLayout;
}

/**
 * Any defined kind. The event definitions are `any` because `FoldEvent<E>` maps over `keyof E`,
 * which makes every shape that holds events invariant in `E`.
 */
// biome-ignore lint/suspicious/noExplicitAny: see above; concrete kinds keep their exact types
export type AnyKind = Kind<string, any, unknown, unknown, unknown>;

/** The states of a kind. */
export type StatesOf<K extends AnyKind> = K["def"]["states"][number];
/** The event definitions of a kind. */
export type EventDefsOf<K extends AnyKind> = K["def"]["events"];
/** The event type names of a kind. */
export type EventTypesOf<K extends AnyKind> = keyof EventDefsOf<K> & string;
/** The `data` type of one event type of a kind. */
export type DataOfType<K extends AnyKind, T extends EventTypesOf<K>> = DataOf<EventDefsOf<K>[T]>;
/** The kind's own reduced state. */
export type StateOf<K extends AnyKind> = ReturnType<K["def"]["reduce"]>;
/** The kind's projection of one subject. */
export type ViewOf<K extends AnyKind> = ReturnType<K["def"]["project"]>;
/** The options the kind's `invariants` and `relate` take. */
export type OptionsOf<K extends AnyKind> = K["def"]["options"];
export type FoldedSubjectOf<K extends AnyKind> = FoldedSubject<
  StatesOf<K>,
  StateOf<K>,
  EventDefsOf<K>
>;
export type FoldedLogOf<K extends AnyKind> = FoldedLog<StatesOf<K>, StateOf<K>, EventDefsOf<K>>;
