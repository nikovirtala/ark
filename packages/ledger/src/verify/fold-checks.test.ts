import { describe, expect, it } from "vitest";
import { compileKind } from "../envelope/kind.js";
import type { EventEnvelope } from "../envelope/types.js";
import { serializeEvent } from "../envelope/yaml.js";
import type { Finding } from "../findings/finding.js";
import { MemoryTree } from "../git/tree.js";
import { bodySha256 } from "../identity/hash.js";
import { eventPath } from "../identity/layout.js";
import { createUlidFactory } from "../identity/ulid.js";
import { defineKind, eventType } from "../kind/define.js";
import type { KindFinding } from "../kind/types.js";
import { TEST_HUMAN } from "../testing/history.js";
import { type Check, mechanicalChecks } from "./checks.js";
import { foldChecks, invariantsCheck, relateCheck, transitions } from "./fold-checks.js";
import { verifySnapshots } from "./verify.js";

interface MemoState {
  readonly links: readonly { readonly to: string; readonly event: string }[];
}

/** A small adr-like kind: accepted (frozen) and rejected (reason required) are terminal. */
const memo = defineKind({
  name: "memo",
  schema: "memo/v1",
  states: ["proposed", "accepted", "rejected"],
  events: {
    proposed: eventType<{ title: string }>()({
      data: { type: "object", required: ["title"], properties: { title: { type: "string" } } },
      allowedIn: [],
      to: "proposed",
    }),
    accepted: eventType<{ body_sha256: string }>()({
      data: {
        type: "object",
        required: ["body_sha256"],
        properties: { body_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" } },
      },
      allowedIn: ["proposed"],
      to: "accepted",
    }),
    rejected: eventType()({
      data: { type: "object" },
      allowedIn: ["proposed"],
      to: "rejected",
      reason: "required",
    }),
    linked: eventType<{ to: string }>()({
      data: { type: "object", required: ["to"], properties: { to: { type: "string" } } },
      allowedIn: "any",
      to: null,
    }),
  },
  initial: "proposed",
  reduce: (state: MemoState | null, e): MemoState => {
    const s = state ?? { links: [] };
    return e.type === "linked" ? { links: [...s.links, { to: e.data.to, event: e.id }] } : s;
  },
  invariants: (s, o: { readonly maxLinks: number }): KindFinding[] => {
    const links = s.state?.links ?? [];
    const over = links[o.maxLinks];
    return over === undefined
      ? []
      : [
          {
            severity: "error",
            rule: "memo/too-many-links",
            message: `more than ${o.maxLinks} links`,
            subject: s.id,
            event: over.event,
          },
        ];
  },
  relate: (log): KindFinding[] =>
    [...log.subjects.values()].flatMap((s) =>
      (s.state?.links ?? []).flatMap(({ to, event }): KindFinding[] => {
        const target = log.subjects.get(to);
        if (target === undefined) {
          return [
            {
              severity: "error",
              rule: "memo/reference-missing",
              message: `links to ${to}, which doesn't exist`,
              subject: s.id,
              event,
              related: [to],
            },
          ];
        }
        return target.status === "rejected"
          ? [
              {
                severity: "error",
                rule: "memo/linked-rejected",
                message: `links to rejected ${to}`,
                subject: s.id,
                event,
                related: [to],
              },
            ]
          : [];
      }),
    ),
  project: (s) => ({ id: s.id }),
  body: { freezeOn: "accepted" },
  layout: { bodies: "memos", events: "events" },
  defaultRoot: "log",
  options: { maxLinks: 2 },
});

const layout = memo.layoutAt("log");
const A = "a7c2m9xd";
const B = "k3f9q8a1";
const C = "mmmmmmmm";
const BODY = "# Memo\n\nText.\n";
const hash = (text: string) => bodySha256(new TextEncoder().encode(text));
const bodyPath = (id: string) => `log/memos/${id}.md`;

let rand = 0;
function ev(
  subject: string,
  type: string,
  at: string,
  data: Record<string, unknown> = {},
  reason?: string,
): EventEnvelope {
  const r = ++rand;
  const id = createUlidFactory({ now: () => Date.parse(at), random: (b) => b.fill(r) })();
  return {
    envelope: "ledger/v1",
    kind: "memo",
    schema: "memo/v1",
    id,
    subject,
    type,
    at,
    actor: TEST_HUMAN,
    ...(reason === undefined ? {} : { reason }),
    data,
  };
}
const file = (...es: EventEnvelope[]) =>
  Object.fromEntries(es.map((e) => [eventPath(layout, e), serializeEvent(e)]));

const aProposed = ev(A, "proposed", "2026-01-01T00:00:00Z", { title: "A" });
const aAccepted = ev(A, "accepted", "2026-01-02T00:00:00Z", { body_sha256: hash(BODY) });
const bProposed = ev(B, "proposed", "2026-01-01T00:00:00Z", { title: "B" });
const accepted: Record<string, string> = { ...file(aProposed, aAccepted), [bodyPath(A)]: BODY };

function verify(
  before: Record<string, string> | null,
  after: Record<string, string>,
  o: { scope?: "all" | "changed"; checks?: readonly Check[] } = {},
): Promise<Finding[]> {
  return verifySnapshots({
    kind: compileKind(memo),
    layout,
    base: before === null ? null : new MemoryTree(before),
    head: new MemoryTree(after),
    scope: o.scope ?? "all",
    ...(o.checks === undefined ? {} : { checks: o.checks }),
  });
}
const brief = (fs: readonly Finding[]) => fs.map((f) => [f.rule, f.file, f.subject]);
const both = ["all", "changed"] as const;

describe("fold checks", () => {
  it("default to the mechanical checks plus transitions, invariants, relate and templates", () => {
    expect(foldChecks(memo).map((c) => c.id)).toEqual([
      ...mechanicalChecks.map((c) => c.id),
      "transitions",
      "invariants",
      "relate",
      "template",
    ]);
  });

  for (const scope of both) {
    it(`find nothing in a legal log (scope ${scope})`, async () => {
      const head = { ...accepted, ...file(bProposed), [bodyPath(B)]: "b\n" };
      expect(await verify(null, head, { scope })).toEqual([]);
      expect(await verify(accepted, head, { scope })).toEqual([]);
    });
  }

  it("report an illegal transition, naming a terminal status", async () => {
    const again = ev(A, "accepted", "2026-01-03T00:00:00Z", { body_sha256: hash(BODY) });
    const findings = await verify(accepted, { ...accepted, ...file(again) });
    expect(brief(findings)).toEqual([["transition/illegal", eventPath(layout, again), A]]);
    expect(findings[0]?.message).toBe(
      "accepted is not allowed while accepted; accepted is terminal",
    );
    expect(findings[0]?.kind).toBe("memo");
  });

  it("report an illegal freeze with a wrong hash as transition/illegal and body/hash-mismatch", async () => {
    const again = ev(A, "accepted", "2026-01-03T00:00:00Z", { body_sha256: hash("other") });
    for (const scope of both) {
      expect(brief(await verify(accepted, { ...accepted, ...file(again) }, { scope }))).toEqual([
        ["body/hash-mismatch", eventPath(layout, again), A],
        ["transition/illegal", eventPath(layout, again), A],
      ]);
    }
  });

  it("don't freeze a body with an illegal freeze event", async () => {
    const rejected = ev(A, "rejected", "2026-01-02T00:00:00Z", {}, "no");
    const late = ev(A, "accepted", "2026-01-03T00:00:00Z", { body_sha256: hash(BODY) });
    const base = { ...file(aProposed, rejected, late), [bodyPath(A)]: BODY };
    expect(brief(await verify(null, base))).toEqual([
      ["transition/illegal", eventPath(layout, late), A],
    ]);
    const { [bodyPath(A)]: _, ...deleted } = base;
    const findings = await verify(base, deleted);
    expect(brief(findings)).toEqual([
      ["body/missing", eventPath(layout, aProposed), A],
      ["transition/illegal", eventPath(layout, late), A],
    ]);
    expect(findings[0]?.message).toBe("body file is missing");
  });

  it("report a frozen body that was deleted, from the applied freeze", async () => {
    const { [bodyPath(A)]: _, ...deleted } = accepted;
    const findings = await verify(accepted, deleted);
    expect(brief(findings)).toEqual([
      ["body/missing", eventPath(layout, aAccepted), A],
      ["body/frozen-deleted", bodyPath(A), A],
    ]);
    expect(findings[0]?.message).toBe(
      `body file is missing; it was frozen by accepted event ${aAccepted.id}`,
    );
  });

  it("report a frozen body that was edited", async () => {
    expect(brief(await verify(accepted, { ...accepted, [bodyPath(A)]: `${BODY}more\n` }))).toEqual([
      ["body/hash-mismatch", eventPath(layout, aAccepted), A],
      ["body/frozen-modified", bodyPath(A), A],
    ]);
  });

  it("report events whose first is not the initial type", async () => {
    const findings = await verify(null, { ...file(aAccepted), [bodyPath(A)]: BODY });
    expect(brief(findings)).toEqual([["transition/not-initial", eventPath(layout, aAccepted), A]]);
    expect(findings[0]?.message).toBe("first event is accepted; it must be proposed");
  });

  it("report a body without events", async () => {
    for (const scope of both) {
      const findings = await verify(accepted, { ...accepted, [bodyPath(B)]: "b\n" }, { scope });
      expect(brief(findings)).toEqual([["transition/no-events", bodyPath(B), B]]);
    }
  });

  it("report a missing reason where one is required", async () => {
    const rejected = ev(B, "rejected", "2026-01-02T00:00:00Z", {}, "  ");
    const head = { ...file(bProposed, rejected), [bodyPath(B)]: "b\n" };
    const findings = await verify(null, head);
    expect(brief(findings)).toEqual([["event/reason-required", eventPath(layout, rejected), B]]);
    expect(findings[0]?.message).toBe("rejected events need a reason");
  });

  it("report events without a body as body/missing", async () => {
    expect(brief(await verify(null, file(bProposed)))).toEqual([
      ["body/missing", eventPath(layout, bProposed), B],
    ]);
  });

  it("run the kind's invariants with its options, or the given ones", async () => {
    const links = [3, 4, 5].map((day) => ev(A, "linked", `2026-01-0${day}T00:00:00Z`, { to: B }));
    const head = { ...accepted, ...file(bProposed, ...links), [bodyPath(B)]: "b\n" };
    expect(brief(await verify(null, head))).toEqual([
      ["memo/too-many-links", eventPath(layout, links[2] as EventEnvelope), A],
    ]);
    const loose = foldChecks(memo, { options: { maxLinks: 5 } });
    expect(await verify(null, head, { checks: loose })).toEqual([]);
    expect(await verify(null, head, { checks: [invariantsCheck({ maxLinks: 0 })] })).toHaveLength(
      1,
    );
  });

  it("run relate on the whole log", async () => {
    const link = ev(A, "linked", "2026-01-03T00:00:00Z", { to: C });
    const findings = await verify(null, { ...accepted, ...file(link) });
    expect(brief(findings)).toEqual([["memo/reference-missing", eventPath(layout, link), A]]);
    expect(findings[0]?.message).toBe(`links to ${C}, which doesn't exist`);
  });

  it("keep relate findings in staged scope when a related subject is in scope", async () => {
    const link = ev(A, "linked", "2026-01-03T00:00:00Z", { to: B });
    const dangling = ev(A, "linked", "2026-01-04T00:00:00Z", { to: C });
    const base = { ...accepted, ...file(bProposed, link, dangling), [bodyPath(B)]: "b\n" };
    const rejected = ev(B, "rejected", "2026-01-05T00:00:00Z", {}, "superseded by events");
    const head = { ...base, ...file(rejected) };
    expect(brief(await verify(base, head, { scope: "changed" }))).toEqual([
      ["memo/linked-rejected", eventPath(layout, link), A],
    ]);
    expect(brief(await verify(base, head, { scope: "all" }))).toEqual([
      ["memo/linked-rejected", eventPath(layout, link), A],
      ["memo/reference-missing", eventPath(layout, dangling), A],
    ]);
  });

  it("return nothing without a fold", async () => {
    const findings = await verifySnapshots({
      kind: compileKind({ name: memo.name, schemas: memo.schemas, body: memo.body }),
      layout,
      base: null,
      head: new MemoryTree(file(aAccepted)),
      scope: "all",
      checks: [transitions, invariantsCheck(), relateCheck()],
    });
    expect(findings).toEqual([]);
  });
});
