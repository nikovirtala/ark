import type { CompiledKind } from "../envelope/kind.js";
import { type Finding, finding } from "../findings/finding.js";
import { bodySha256, findDuplicates } from "../identity/hash.js";
import { classifyPath, type LogLayout } from "../identity/layout.js";
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
}

/** A verify check. Step 3 adds transition and invariant checks through this interface. */
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

/**
 * `{ freezeOn }` bodies: every freeze event records the body's hash, a frozen subject has its
 * body, and a body frozen at base doesn't change or disappear. Whether the freeze was a legal
 * transition is a step-3 check.
 */
export const bodyPolicy: Check = {
  id: "body",
  run(ctx) {
    const policy = ctx.kind.kind.body;
    if (typeof policy !== "object") return [];
    const { freezeOn } = policy;
    const hashField = policy.hashField ?? "body_sha256";
    const out: Finding[] = [];
    for (const id of [...ctx.inScope].sort()) {
      const head = ctx.head.subjects.get(id);
      // Several bodies: duplicate-subject-id is the only body finding.
      if (head !== undefined && head.bodyPaths.length > 1) continue;
      const headBody = head?.body ?? null;
      const headHash = headBody === null ? null : bodySha256(headBody.bytes);
      const frozenBy = freezeEvents(head, freezeOn);
      for (const e of frozenBy) {
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
      const [first] = frozenBy;
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
      if (headBody === null) {
        out.push(
          error(
            "body/frozen-deleted",
            `body deleted after it was frozen by ${by}`,
            baseBody.path,
            id,
          ),
        );
      } else if (headBody.path !== baseBody.path) {
        out.push(
          error(
            "body/frozen-modified",
            `body renamed from ${baseBody.path} after it was frozen by ${by}`,
            headBody.path,
            id,
          ),
        );
      } else if (headHash !== bodySha256(baseBody.bytes)) {
        out.push(
          error(
            "body/frozen-modified",
            `body changed after it was frozen by ${by}`,
            headBody.path,
            id,
          ),
        );
      }
    }
    return out;
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
