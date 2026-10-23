import { MemoryTree, NO_NUMBERING, treeTemplates } from "@nikovirtala/ledger";
import { TEST_HUMAN } from "@nikovirtala/ledger/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_ADR_CONFIG } from "./config.js";
import { type DecisionsRead, readDecisionsFrom } from "./log.js";
import { BUILTIN_TEMPLATES } from "./templates/builtin.js";
import { LAYOUT } from "./test-support/events.js";
import {
  type PlanContext,
  type PlanResult,
  planAccept,
  planDeprecate,
  planEvent,
  planPropose,
  planReject,
  planSupersede,
  planWithdraw,
} from "./write.js";

// AC 6: random command sequences through the plan functions on a MemoryTree, each plan's files
// merged into the tree and re-read, against a hand-written reference model of 01:156–165.

type Status = "proposed" | "accepted" | "rejected" | "withdrawn" | "deprecated" | "superseded";

interface Model {
  status: Status;
  declared: string[];
  supersededBy: string | null;
  notes: number;
  links: { to: string; rel: string }[];
  scope: string[];
}

type Command =
  | { readonly type: "propose"; readonly supersedes: readonly number[] }
  | { readonly type: "accept" | "reject" | "withdraw" | "deprecate" | "note"; readonly x: number }
  | { readonly type: "supersede"; readonly x: number; readonly by: number }
  | { readonly type: "link"; readonly x: number; readonly to: number }
  | { readonly type: "scope"; readonly x: number; readonly set: readonly string[] };

const index = fc.nat({ max: 50 });
const arbCommand: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc
      .array(index, { maxLength: 2 })
      .map((supersedes) => ({ type: "propose" as const, supersedes })),
  },
  {
    weight: 3,
    arbitrary: index.map((x) => ({ type: "accept" as const, x })),
  },
  fc
    .tuple(
      fc.constantFrom(
        "reject" as const,
        "withdraw" as const,
        "deprecate" as const,
        "note" as const,
      ),
      index,
    )
    .map(([type, x]) => ({ type, x })),
  {
    weight: 2,
    arbitrary: fc.tuple(index, index).map(([x, by]) => ({ type: "supersede" as const, x, by })),
  },
  fc.tuple(index, index).map(([x, to]) => ({ type: "link" as const, x, to })),
  fc
    .tuple(
      index,
      fc.uniqueArray(fc.constantFrom("src/**", "docs/**", "infra/*.tf"), { maxLength: 2 }),
    )
    .map(([x, set]) => ({ type: "scope" as const, x, set })),
);

const SECTIONS = {
  context: "We need a database.",
  decision: "We will use Aurora.",
  scope: "src/orders/**",
  consequences: "One more service to run.",
};

/** A deterministic xorshift byte stream, so ids replay from the seed. */
function randomFrom(seed: number): (buf: Uint8Array) => void {
  let x = seed | 1;
  return (buf) => {
    for (let i = 0; i < buf.length; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      buf[i] = x & 0xff;
    }
  };
}

/** The reference model's verdict on a command; mutates `models` only when it is legal. */
function referenceStep(
  models: Map<string, Model>,
  order: readonly string[],
  cmd: Command,
  newId: string | null,
): boolean {
  const pick = (i: number) => order[i % order.length] ?? "";
  const m = (id: string) => models.get(id) as Model;
  switch (cmd.type) {
    case "propose": {
      if (newId === null) throw new Error("propose needs the new id");
      models.set(newId, {
        status: "proposed",
        declared: [...new Set(order.length === 0 ? [] : cmd.supersedes.map(pick))].sort(),
        supersededBy: null,
        notes: 0,
        links: [],
        scope: [],
      });
      return true;
    }
    case "accept": {
      const x = pick(cmd.x);
      const d = m(x);
      const ok =
        d.status === "proposed" &&
        d.declared.every((t) => t !== x && ["accepted", "deprecated"].includes(m(t).status));
      if (ok) {
        d.status = "accepted";
        for (const t of d.declared) {
          m(t).status = "superseded";
          m(t).supersededBy = x;
        }
      }
      return ok;
    }
    case "reject":
    case "withdraw": {
      const d = m(pick(cmd.x));
      if (d.status !== "proposed") return false;
      d.status = cmd.type === "reject" ? "rejected" : "withdrawn";
      return true;
    }
    case "deprecate": {
      const d = m(pick(cmd.x));
      if (d.status !== "accepted") return false;
      d.status = "deprecated";
      return true;
    }
    case "supersede": {
      const x = pick(cmd.x);
      const by = pick(cmd.by);
      const d = m(x);
      const ok =
        (d.status === "accepted" || d.status === "deprecated") &&
        x !== by &&
        m(by).status === "accepted";
      if (ok) {
        d.status = "superseded";
        d.supersededBy = by;
      }
      return ok;
    }
    case "note":
      m(pick(cmd.x)).notes += 1;
      return true;
    case "link": {
      const d = m(pick(cmd.x));
      const to = pick(cmd.to);
      if (!d.links.some((l) => l.to === to)) d.links.push({ to, rel: "relates-to" });
      return true;
    }
    case "scope": {
      const d = m(pick(cmd.x));
      if (!["proposed", "accepted", "deprecated"].includes(d.status)) return false;
      d.scope = [...cmd.set];
      return true;
    }
  }
}

/** What the model says the projection of `id` holds. */
function expectedView(models: ReadonlyMap<string, Model>, id: string) {
  const d = models.get(id) as Model;
  const chain = [id];
  for (let next = d.supersededBy; next !== null; next = models.get(next)?.supersededBy ?? null) {
    chain.push(next);
  }
  return {
    status: d.status,
    superseded_by: d.supersededBy,
    supersedes: [...models]
      .filter(([, o]) => o.supersededBy === id)
      .map(([k]) => k)
      .sort(),
    declared_supersedes: d.declared,
    effective: chain.at(-1),
    chain,
    notes: d.notes,
    links: d.links,
    applies_to: d.scope,
  };
}

const reread = (files: Record<string, Uint8Array>) =>
  readDecisionsFrom(new MemoryTree(files), {
    layout: LAYOUT,
    adr: DEFAULT_ADR_CONFIG,
    numbering: NO_NUMBERING,
  });

async function plan(
  read: DecisionsRead,
  order: readonly string[],
  cmd: Command,
  c: PlanContext,
): Promise<PlanResult> {
  const pick = (i: number) => order[i % order.length] ?? "";
  const actor = TEST_HUMAN;
  switch (cmd.type) {
    case "propose":
      return planPropose(
        read,
        {
          title: `Decision ${order.length + 1}`,
          sections: SECTIONS,
          supersedes: order.length === 0 ? [] : cmd.supersedes.map(pick),
          actor,
        },
        c,
      );
    case "accept":
      return planAccept(read, { id: pick(cmd.x), actor }, c);
    case "supersede":
      return planSupersede(read, { id: pick(cmd.x), by: pick(cmd.by), actor }, c);
    case "reject":
      return planReject(read, { id: pick(cmd.x), reason: "too costly", actor }, c);
    case "withdraw":
      return planWithdraw(read, { id: pick(cmd.x), actor }, c);
    case "deprecate":
      return planDeprecate(read, { id: pick(cmd.x), reason: "obsolete", actor }, c);
    case "note":
      return planEvent(
        read,
        { subject: pick(cmd.x), type: "noted", data: { text: "a note" }, actor },
        c,
      );
    case "link":
      return planEvent(
        read,
        {
          subject: pick(cmd.x),
          type: "linked",
          data: { to: pick(cmd.to), rel: "relates-to" },
          actor,
        },
        c,
      );
    case "scope":
      return planEvent(
        read,
        { subject: pick(cmd.x), type: "scoped", data: { set: [...cmd.set] }, actor },
        c,
      );
  }
}

describe("write plans (AC 6)", () => {
  it("follow the reference model of the decision lifecycle", async () => {
    const seen = new Set<string>();
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbCommand, { minLength: 1, maxLength: 25 }),
        fc.integer(),
        async (cmds, seed) => {
          let clock = Date.parse("2026-03-12T09:00:00Z");
          const random = randomFrom(seed);
          const files: Record<string, Uint8Array> = {};
          const models = new Map<string, Model>();
          const order: string[] = [];
          let read = await reread(files);
          for (const cmd of cmds) {
            if (cmd.type !== "propose" && order.length === 0) continue;
            const c: PlanContext = {
              now: () => (clock += 1000),
              random,
              templates: treeTemplates(read.tree, `${LAYOUT.root}/templates`),
              builtins: BUILTIN_TEMPLATES,
            };
            const r = await plan(read, order, cmd, c);
            const legal = referenceStep(models, order, cmd, r.ok ? r.plan.subject : null);
            expect(r.ok, JSON.stringify({ cmd, r: r.ok ? null : r.findings })).toBe(legal);
            seen.add(`${cmd.type} ${r.ok}`);
            if (r.ok) {
              if (cmd.type === "propose") order.push(r.plan.subject);
              Object.assign(files, r.plan.files);
              read = await reread(files);
              expect(r.plan.decision).toEqual(read.projection.views.get(r.plan.subject));
            }
            expect(read.findings).toEqual([]);
            for (const id of order) {
              expect(read.projection.views.get(id)).toMatchObject(expectedView(models, id));
            }
          }
        },
      ),
    );
  });
});
