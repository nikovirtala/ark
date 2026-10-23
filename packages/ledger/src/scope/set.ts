/**
 * Whole-set events and the set-op helper (design §3.2, G11): a set event carries the complete set,
 * the latest applied one wins, and writes store it sorted and deduplicated (D-b).
 */
import type { JsonSchema } from "../envelope/types.js";
import { UsageError } from "../errors.js";
import type { EventDefs, EventTypeDef, FoldedSubject } from "../kind/types.js";

/** A whole-set event type: `data: { set: string[] }` with unique items; it never changes state. */
export function setEventType<const S extends string>(o: {
  readonly item: JsonSchema;
  readonly maxItems: number;
  readonly allowedIn: readonly S[] | "any";
}): EventTypeDef<S, { set: string[] }> {
  return {
    data: {
      type: "object",
      required: ["set"],
      properties: {
        set: { type: "array", items: o.item, uniqueItems: true, maxItems: o.maxItems },
      },
    },
    allowedIn: o.allowedIn,
    to: null,
  };
}

/** The `data.set` of the subject's last applied event of `type` in fold order; `null` if none. */
export function latestSet<S extends string, St, E extends EventDefs<S>>(
  subject: FoldedSubject<S, St, E>,
  type: string,
): readonly string[] | null {
  for (let i = subject.applied.length - 1; i >= 0; i--) {
    const e = subject.applied[i]?.event;
    if (e?.type !== type) continue;
    const set = (e.data as { readonly set?: unknown }).set;
    return Array.isArray(set) ? (set as string[]) : null;
  }
  return null;
}

export interface SetOp {
  /** Replace the set; `[]` clears it. */
  readonly set?: readonly string[];
  readonly add?: readonly string[];
  readonly remove?: readonly string[];
}

export interface SetOpResult {
  /** Sorted by UTF-16 code unit, deduplicated. */
  readonly set: readonly string[];
  /** `set` differs from the sorted, deduplicated current set. */
  readonly changed: boolean;
  /** In `set`, not in current; sorted. */
  readonly added: readonly string[];
  /** In current, not in `set`; sorted. */
  readonly removed: readonly string[];
  /** `remove` items that weren't in current. */
  readonly absent: readonly string[];
  /** `add` items that already were in current. */
  readonly present: readonly string[];
}

const canonical = (xs: Iterable<string>) => [...new Set(xs)].sort();

/**
 * Applies a set operation to `current` (design §3.2 rules 1–6). Throws `UsageError` for no
 * operation, `set` with `add`/`remove`, an item both added and removed, an invalid `set`/`add`
 * item, or a result over `maxItems`. `remove` items aren't validated, so a hand-written invalid
 * item can still be removed.
 */
export function applySetOp(
  current: readonly string[],
  op: SetOp,
  o: {
    /** What the items are, for messages ("glob", "label"); default "item". */
    readonly what?: string;
    /** `null` when the item is valid, else the message. */
    readonly validate?: (item: string) => string | null;
    readonly maxItems?: number;
    /** How the caller names the inputs in messages; default the field names. */
    readonly names?: {
      readonly set: string;
      readonly add: string;
      readonly remove: string;
      readonly clear?: string;
    };
  } = {},
): SetOpResult {
  const what = o.what ?? "item";
  const names = o.names ?? { set: "set", add: "add", remove: "remove" };
  const add = op.add ?? [];
  const remove = op.remove ?? [];
  if (op.set === undefined && add.length === 0 && remove.length === 0) {
    const list =
      names.clear === undefined
        ? `${names.set}, ${names.add} or ${names.remove}`
        : `${names.set}, ${names.add}, ${names.remove} or ${names.clear}`;
    throw new UsageError(`nothing to change: give ${list}`);
  }
  if (op.set !== undefined && (add.length > 0 || remove.length > 0)) {
    throw new UsageError(`${names.set} can't be combined with ${names.add} or ${names.remove}`);
  }
  const removing = new Set(remove);
  const both = add.find((x) => removing.has(x));
  if (both !== undefined) throw new UsageError(`${what} ${both} is both added and removed`);
  if (o.validate !== undefined) {
    for (const item of op.set ?? add) {
      const problem = o.validate(item);
      if (problem !== null) throw new UsageError(problem);
    }
  }

  const before = canonical(current);
  const had = new Set(before);
  const set =
    op.set !== undefined
      ? canonical(op.set)
      : canonical([...before.filter((x) => !removing.has(x)), ...add]);
  if (o.maxItems !== undefined && set.length > o.maxItems) {
    throw new UsageError(`${set.length} ${what}s; the limit is ${o.maxItems}`);
  }
  const has = new Set(set);
  const replacing = op.set !== undefined;
  return {
    set,
    changed: set.length !== before.length || set.some((x, i) => x !== before[i]),
    added: set.filter((x) => !had.has(x)),
    removed: before.filter((x) => !has.has(x)),
    absent: replacing ? [] : canonical(remove.filter((x) => !had.has(x))),
    present: replacing ? [] : canonical(add.filter((x) => had.has(x))),
  };
}
