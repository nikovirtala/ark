import type { CompiledKind } from "../envelope/kind.js";
import { type Finding, finding } from "../findings/finding.js";
import { bodySha256, findDuplicates } from "../identity/hash.js";
import { classifyPath, type LogLayout } from "../identity/layout.js";
import type { AnyKind, FoldedLogOf, FoldedSubjectOf } from "../kind/types.js";
import type { LoadedEvent, LoadedSubject, LogSnapshot } from "../log/snapshot.js";
import type { Change } from "./diff.js";

export interface CheckContext {
  readonly kind: CompiledKind;
  readonly layout: LogLayout;
  /** `null` in full mode, and in staged mode on an unborn `HEAD`. */
  readonly base: LogSnapshot | null;
  readonly head: LogSnapshot;
  /** Changes within `layout.root`. */
  readonly changes: readonly Change[];
  readonly scope: "changed" | "all";
  /** The subject ids the checks must examine. */
  readonly inScope: ReadonlySet<string>;
  /**
   * Set by `verifySnapshots` when the kind is a `defineKind` kind. Optional so that code building
   * a `CheckContext` by hand keeps compiling; absent or `null` means "not folded".
   */
  readonly folded?: {
    readonly head: FoldedLogOf<AnyKind>;
    readonly base: FoldedLogOf<AnyKind> | null;
  } | null;
}

/** A verify check: the mechanical checks, and the fold checks of `foldChecks`. */
export interface Check {
  readonly id: string;
  run(ctx: CheckContext): Finding[] | Promise<Finding[]>;
}

const error = (rule: string, message: string, file: string | null, subject: string | null) =>
  finding({ severity: "error", rule, message, file, subject });

function inScopeSubjects(snap: LogSnapshot, ctx: CheckContext): LoadedSubject[] {
  return [...snap.subjects.values()].filter((s) => ctx.inScope.has(s.id));
}

/**
 * The findings made while loading: per-file and per-subject findings of in-scope subjects, plus
 * structural findings. In scope `changed`, structural findings count only for added or modified
 * paths, so pre-existing problems in untouched paths are left to a full check.
 */
export const loadFindings: Check = {
  id: "load",
  run(ctx) {
    const touched = new Set(ctx.changes.filter((c) => c.status !== "deleted").map((c) => c.path));
    const structural =
      ctx.scope === "all"
        ? ctx.head.structural
        : ctx.head.structural.filter((f) => f.file !== null && touched.has(f.file));
    return [
      ...structural,
      ...inScopeSubjects(ctx.head, ctx).flatMap((s) => [
        ...s.findings,
        ...s.events.flatMap((e) => e.findings),
      ]),
    ];
  },
};

/** Existing event files are never modified, renamed or deleted. */
export const appendOnly: Check = {
  id: "append-only",
  run(ctx) {
    const out: Finding[] = [];
    for (const c of ctx.changes) {
      if (c.status === "added") continue;
      const p = classifyPath(ctx.layout, c.path);
      // Only files a log loads as events; moving a misplaced file out of the way is allowed.
      if (p.area !== "event" || p.subject === null || p.file.includes("/")) continue;
      if (!/\.ya?ml$/.test(p.file)) continue;
      const what = c.status === "deleted" ? "deleted" : "modified";
      out.push(
        error(
          `append-only/${what}`,
          `event file was ${what}; event files are append-only`,
          c.path,
          p.subject,
        ),
      );
    }
    return out;
  },
};

/** The subject's valid events of the freeze type, in file-name order. */
function freezeEvents(s: LoadedSubject | undefined, freezeOn: string): LoadedEvent[] {
  return s === undefined ? [] : s.events.filter((e) => e.event?.type === freezeOn);
}

/** The first freeze-type event the fold applied, as the event that froze the body. */
function appliedFreeze(
  s: FoldedSubjectOf<AnyKind> | undefined,
  freezeOn: string,
): { readonly path: string; readonly by: string } | undefined {
  const a = s?.applied.find((x) => x.event.type === freezeOn);
  return a === undefined ? undefined : { path: a.path, by: `${freezeOn} event ${a.event.id}` };
}

interface Freeze {
  readonly freezeOn: string;
  readonly hashField: string;
}

/** Every valid freeze-type event records the body's current hash. */
function hashFindings(
  id: string,
  head: LoadedSubject | undefined,
  headHash: string | null,
  { freezeOn, hashField }: Freeze,
): Finding[] {
  const out: Finding[] = [];
  for (const e of freezeEvents(head, freezeOn)) {
    const recorded = e.event?.data[hashField];
    const eventId = e.event?.id ?? "";
    if (typeof recorded !== "string" || !/^[0-9a-f]{64}$/.test(recorded)) {
      out.push(
        error(
          "body/missing-hash",
          `${freezeOn} event ${eventId} must record the body hash in ${hashField} (64 lowercase hex chars)`,
          e.path,
          id,
        ),
      );
    } else if (headHash !== null && recorded !== headHash) {
      out.push(
        error(
          "body/hash-mismatch",
          `body does not match the hash recorded by ${freezeOn} event ${eventId}`,
          e.path,
          id,
        ),
      );
    }
  }
  return out;
}

type Body = NonNullable<LoadedSubject["body"]>;

/** A body frozen at base (`by` names the freeze event) that changed, moved or went away in head. */
function frozenFindings(
  id: string,
  by: string,
  baseBody: Body,
  headBody: Body | null,
  headHash: string | null,
): Finding[] {
  if (headBody === null) {
    return [
      error("body/frozen-deleted", `body deleted after it was frozen by ${by}`, baseBody.path, id),
    ];
  }
  if (headBody.path !== baseBody.path) {
    return [
      error(
        "body/frozen-modified",
        `body renamed from ${baseBody.path} after it was frozen by ${by}`,
        headBody.path,
        id,
      ),
    ];
  }
  if (headHash !== bodySha256(baseBody.bytes)) {
    return [
      error("body/frozen-modified", `body changed after it was frozen by ${by}`, headBody.path, id),
    ];
  }
  return [];
}

/**
 * Without a fold: `{ freezeOn }` bodies only. Every freeze event records the body's hash, a subject
 * with a freeze event has its body, and a body frozen at base doesn't change or disappear.
 */
function presenceBodyPolicy(ctx: CheckContext): Finding[] {
  const policy = ctx.kind.kind.body;
  if (typeof policy !== "object") return [];
  const freeze = { freezeOn: policy.freezeOn, hashField: policy.hashField ?? "body_sha256" };
  const { freezeOn } = freeze;
  const out: Finding[] = [];
  for (const id of [...ctx.inScope].sort()) {
    const head = ctx.head.subjects.get(id);
    // Several bodies: duplicate-subject-id is the only body finding.
    if (head !== undefined && head.bodyPaths.length > 1) continue;
    const headBody = head?.body ?? null;
    const headHash = headBody === null ? null : bodySha256(headBody.bytes);
    out.push(...hashFindings(id, head, headHash, freeze));
    const [first] = freezeEvents(head, freezeOn);
    if (first !== undefined && headBody === null) {
      out.push(
        error(
          "body/missing",
          `body file is missing; it was frozen by ${freezeOn} event ${first.event?.id ?? ""}`,
          first.path,
          id,
        ),
      );
    }

    const base = ctx.base?.subjects.get(id);
    const [baseFreeze] = freezeEvents(base, freezeOn);
    const baseBody = base?.body ?? null;
    if (baseFreeze === undefined || baseBody === null) continue;
    const by = `${freezeOn} event ${baseFreeze.event?.id ?? ""}`;
    out.push(...frozenFindings(id, by, baseBody, headBody, headHash));
  }
  return out;
}

/**
 * With a fold. The hash checks still cover every valid freeze-type event, applied or not. Being
 * frozen comes from the first applied freeze event only, so an illegal freeze freezes nothing.
 * Every subject with applied events of a kind with bodies must have its body file.
 */
function foldedBodyPolicy(
  ctx: CheckContext,
  folded: NonNullable<CheckContext["folded"]>,
): Finding[] {
  const policy = ctx.kind.kind.body;
  if (policy === "none") return [];
  const freeze =
    typeof policy === "object"
      ? { freezeOn: policy.freezeOn, hashField: policy.hashField ?? "body_sha256" }
      : null;
  const out: Finding[] = [];
  for (const id of [...ctx.inScope].sort()) {
    const head = ctx.head.subjects.get(id);
    if (head !== undefined && head.bodyPaths.length > 1) continue;
    const headBody = head?.body ?? null;
    const headHash = headBody === null ? null : bodySha256(headBody.bytes);
    if (freeze !== null) out.push(...hashFindings(id, head, headHash, freeze));
    const fold = folded.head.subjects.get(id);
    const frozenBy = freeze === null ? undefined : appliedFreeze(fold, freeze.freezeOn);
    const [first] = fold?.applied ?? [];
    if (headBody === null && frozenBy !== undefined) {
      out.push(
        error(
          "body/missing",
          `body file is missing; it was frozen by ${frozenBy.by}`,
          frozenBy.path,
          id,
        ),
      );
    } else if (headBody === null && first !== undefined) {
      out.push(error("body/missing", "body file is missing", first.path, id));
    }

    if (freeze === null) continue;
    const baseFreeze = appliedFreeze(folded.base?.subjects.get(id), freeze.freezeOn);
    const baseBody = ctx.base?.subjects.get(id)?.body ?? null;
    if (baseFreeze === undefined || baseBody === null) continue;
    out.push(...frozenFindings(id, baseFreeze.by, baseBody, headBody, headHash));
  }
  return out;
}

/**
 * Body rules. Whether a freeze was a legal transition is decided by the fold: with `ctx.folded`,
 * only an applied freeze event freezes the body (see `foldedBodyPolicy`).
 */
export const bodyPolicy: Check = {
  id: "body",
  run(ctx) {
    const folded = ctx.folded ?? null;
    return folded === null ? presenceBodyPolicy(ctx) : foldedBodyPolicy(ctx, folded);
  },
};

/**
 * Two bodies for one subject id, or one event id in several files. In scope `changed` only
 * in-scope subjects are compared, which keeps the staged hook fast; a full check covers the log.
 */
export const duplicates: Check = {
  id: "duplicates",
  run(ctx) {
    const out: Finding[] = [];
    const subjects = inScopeSubjects(ctx.head, ctx);
    for (const s of subjects) {
      if (s.bodyPaths.length < 2) continue;
      for (const path of s.bodyPaths) {
        out.push(
          error(
            "identity/duplicate-subject-id",
            `subject id ${s.id} is used by ${s.bodyPaths.length} body files`,
            path,
            s.id,
          ),
        );
      }
    }
    const events = subjects.flatMap((s) =>
      s.events.flatMap((e) => (e.event === null ? [] : [{ s, e, id: e.event.id }])),
    );
    for (const [id, group] of findDuplicates(events, (x) => x.id)) {
      for (const { s, e } of group) {
        out.push(
          error(
            "identity/duplicate-event-id",
            `event id ${id} is used by ${group.length} event files`,
            e.path,
            s.id,
          ),
        );
      }
    }
    return out;
  },
};

/** The step-2 checks, in order. */
export const mechanicalChecks: readonly Check[] = Object.freeze([
  loadFindings,
  appendOnly,
  bodyPolicy,
  duplicates,
]);
