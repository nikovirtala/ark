/**
 * Test-only generators for decision logs (design §9). Never bundled or packed: excluded from
 * `tsconfig.json`, included in `tsconfig.test.json`.
 */
import {
  type EventEnvelope,
  eventPath,
  nextEventIdentity,
  serializeEvent,
} from "@nikovirtala/ledger";
import {
  arbLegalHistory,
  arbSubjectId,
  type DataArbs,
  finalHistoryContext,
  type HistoryContext,
  type LegalHistory,
  TEST_HUMAN,
} from "@nikovirtala/ledger/testing";
import fc from "fast-check";
import { adrKind, type DecisionState } from "../kind.js";

export type AdrKind = typeof adrKind;
export type AdrHistory = LegalHistory<AdrKind>;

const others = (ctx: HistoryContext) => ctx.subjects.filter((id) => id !== ctx.subject);
const title = fc
  .string({ minLength: 1, maxLength: 60 })
  .map((s) => s.replace(/[\r\n]/g, " ").trim())
  .filter((s) => s !== "");
const GLOBS = ["src/**", "docs/**", "infra/*.tf", "package.json"] as const;

/**
 * Data for `arbLegalHistory(adrKind, …)`. References only name subjects that exist, and
 * `superseded.by` only names a currently accepted one, so untampered histories have no findings.
 */
export const adrDataArbs: DataArbs<AdrKind> = {
  proposed: (ctx) => {
    const ids = others(ctx);
    const supersedes =
      ids.length === 0
        ? fc.constant(undefined)
        : fc.option(fc.uniqueArray(fc.constantFrom(...ids), { minLength: 1, maxLength: 2 }), {
            nil: undefined,
          });
    return fc.record({ title, supersedes }).map(({ title, supersedes }) => ({
      title,
      template: "nygard",
      template_version: 1,
      ...(supersedes === undefined ? {} : { supersedes }),
    }));
  },
  accepted: () => fc.constant({}),
  rejected: () => fc.constant({}),
  withdrawn: () => fc.constant({}),
  deprecated: () => fc.constant({}),
  superseded: (ctx) => {
    const accepted = others(ctx).filter((id) => ctx.status(id) === "accepted");
    return accepted.length === 0 ? null : fc.constantFrom(...accepted).map((by) => ({ by }));
  },
  noted: () => fc.record({ text: fc.string({ minLength: 1, maxLength: 200 }) }),
  linked: (ctx) => {
    const ids = others(ctx);
    return ids.length === 0
      ? null
      : fc.record({
          to: fc.constantFrom(...ids),
          rel: fc.constantFrom("relates-to" as const, "refines" as const, "depends-on" as const),
        });
  },
  scoped: () => fc.record({ set: fc.uniqueArray(fc.constantFrom(...GLOBS), { maxLength: 3 }) }),
};

/** Decision body text: 0–2000 arbitrary characters. */
export const adrBody = (): fc.Arbitrary<string> => fc.string({ maxLength: 2000 });

/**
 * `adrDataArbs` limited to proposing, accepting and superseding, so most histories hold
 * supersessions: the supersession tampers need one, and with every type enabled only a few
 * percent of histories have a candidate.
 */
export const adrSupersessionArbs: DataArbs<AdrKind> = {
  ...adrDataArbs,
  rejected: () => null,
  withdrawn: () => null,
  deprecated: () => null,
  noted: () => null,
  linked: () => null,
  scoped: () => null,
};

/** The layout of generated decision logs: adr's default root. */
export const ADR_LAYOUT = adrKind.layoutAt("docs/adr");

/** Legal decision histories under `docs/adr`, with adr's generators. */
export function arbAdrHistory(
  o: {
    readonly data?: DataArbs<AdrKind>;
    readonly subjects?: { min: number; max: number };
    readonly maxSteps?: number;
  } = {},
): fc.Arbitrary<AdrHistory> {
  return arbLegalHistory(adrKind, {
    layout: ADR_LAYOUT,
    body: adrBody,
    ...o,
    data: o.data ?? adrDataArbs,
  });
}

/** adr's own tampers (design §9); every one rewrites or adds exactly the file at `path`. */
export type AdrTamper = {
  readonly type:
    | "dangling-superseded-by"
    | "supersession-cycle"
    | "agent-acceptance"
    | "accepted-body-edited";
  readonly path: string;
  readonly content: string;
};

/** The rules verify may report for each adr tamper; at least one fires, as an error. */
export const adrExpectedRules: Readonly<Record<AdrTamper["type"], readonly string[]>> =
  Object.freeze({
    "dangling-superseded-by": ["decision/reference-missing"],
    "supersession-cycle": ["decision/supersession-cycle"],
    "agent-acceptance": ["decision/agent-accepted"],
    "accepted-body-edited": ["body/hash-mismatch", "body/frozen-modified"],
  });

/** A new map with `m` applied; `files` is never mutated. */
export function applyAdrTamper(
  files: Readonly<Record<string, string>>,
  m: AdrTamper,
): Record<string, string> {
  return { ...files, [m.path]: m.content };
}

/**
 * The environment for spawning `adr` on `repo` (design §9): the process env with the repo's
 * hermetic git env over it, and no `ARK_AGENT`, `VISUAL` or `EDITOR` unless `testEnv` sets them,
 * so a developer's or agent's own settings never reach the child. Keys left `undefined` are
 * removed.
 */
export function cliEnv(
  repo: { readonly env: NodeJS.ProcessEnv },
  testEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {
    ...process.env,
    ...repo.env,
    ARK_AGENT: undefined,
    VISUAL: undefined,
    EDITOR: undefined,
    ...testEnv,
  };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
  return merged;
}

/** The actor the agent-acceptance tamper writes. */
export const TEST_AGENT = Object.freeze({
  kind: "agent" as const,
  name: "test-agent",
  email: null,
  agent: "test-agent",
  on_behalf_of: "test@example.com",
});

/**
 * One adr tamper of `h` among the types in `o.only` (default all) that have a candidate; `null`
 * when none has one.
 */
export function arbAdrTamper(
  h: AdrHistory,
  o: { readonly only?: readonly AdrTamper["type"][] } = {},
): fc.Arbitrary<AdrTamper> | null {
  const allowed = new Set(o.only ?? Object.keys(adrExpectedRules));
  const first = h.steps[0]?.subject;
  if (first === undefined) return null;
  const ctx = finalHistoryContext(h, adrKind, first);
  const state = (id: string) => ctx.state(id) as DecisionState | null;
  const ids = new Set(h.subjects.map((s) => s.id));
  const candidates: fc.Arbitrary<AdrTamper>[] = [];

  const superseded = h.steps.filter((s) => s.event.type === "superseded");
  if (allowed.has("dangling-superseded-by") && superseded.length > 0) {
    candidates.push(
      fc
        .tuple(
          fc.constantFrom(...superseded),
          arbSubjectId().filter((id) => !ids.has(id)),
        )
        .map(([s, fresh]) => ({
          type: "dangling-superseded-by" as const,
          path: s.path,
          content: serializeEvent({ ...s.event, data: { ...s.event.data, by: fresh } }),
        })),
    );
  }

  if (allowed.has("supersession-cycle")) {
    const latest = h.steps.at(-1)?.event.at ?? "2001-01-01T00:00:00Z";
    const cycles = h.subjects.flatMap((s) => {
      if (ctx.status(s.id) !== "superseded") return [];
      let head = s.id;
      const seen = new Set([head]);
      for (;;) {
        const next = state(head)?.supersededBy ?? null;
        if (next === null || seen.has(next)) break;
        seen.add(next);
        head = next;
      }
      return head !== s.id && ctx.status(head) === "accepted" ? [{ a: s.id, head }] : [];
    });
    if (cycles.length > 0) {
      candidates.push(
        fc
          .tuple(fc.constantFrom(...cycles), fc.uint8Array({ minLength: 10, maxLength: 10 }))
          .map(([{ a, head }, bytes]) => {
            const previous = h.steps.filter((s) => s.subject === head).map((s) => s.event);
            const { at, id } = nextEventIdentity(previous, {
              now: () => Date.parse(latest) + 1000,
              random: (buf) => buf.set(bytes),
            });
            const event: EventEnvelope = {
              envelope: "ledger/v1",
              kind: adrKind.name,
              schema: adrKind.schema,
              id,
              subject: head,
              type: "superseded",
              at,
              actor: TEST_HUMAN,
              data: { by: a },
            };
            return {
              type: "supersession-cycle" as const,
              path: eventPath(h.layout, event),
              content: serializeEvent(event),
            };
          }),
      );
    }
  }

  const accepted = h.steps.filter((s) => s.event.type === "accepted");
  if (allowed.has("agent-acceptance") && accepted.length > 0) {
    candidates.push(
      fc.constantFrom(...accepted).map((s) => ({
        type: "agent-acceptance" as const,
        path: s.path,
        content: serializeEvent({ ...s.event, actor: TEST_AGENT }),
      })),
    );
  }

  const frozen = h.subjects.flatMap((s) =>
    s.frozen && s.bodyPath !== null ? [{ path: s.bodyPath, text: h.files[s.bodyPath] ?? "" }] : [],
  );
  if (allowed.has("accepted-body-edited") && frozen.length > 0) {
    candidates.push(
      fc.constantFrom(...frozen).chain(({ path, text }) =>
        adrBody()
          .filter((t) => t !== text)
          .map((content) => ({ type: "accepted-body-edited" as const, path, content })),
      ),
    );
  }
  return candidates.length === 0 ? null : fc.oneof(...candidates);
}
