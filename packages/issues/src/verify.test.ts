import { compileKind, type Finding, MemoryTree, verifySnapshots } from "@nikovirtala/ledger";
import {
  applySemanticTamper,
  applyTamper,
  arbSemanticTamper,
  arbTamper,
  createTempRepo,
  expectedRules,
  semanticExpectedRules,
} from "@nikovirtala/ledger/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { issueKind } from "./kind.js";
import { openIssueLog } from "./log.js";
import { TASK_V1 } from "./templates/builtin.js";
import { ISSUE_TEST_OPTIONS } from "./test-support/arbitraries.js";
import { issueFiles, opened } from "./test-support/events.js";
import {
  arbIssueHistory,
  arbIssueMutation,
  HISTORY_LAYOUT,
  type IssueHistory,
  type IssueMutationType,
  issueChecks,
  issueDataArbs,
  MUTATION_RULES,
  MUTATION_TYPES,
  TEMPLATE_PATH,
} from "./test-support/history.js";
import { verifyIssues } from "./verify.js";

const COMPILED = compileKind(issueKind);
const scopes = ["all", "changed"] as const;
const RUNS = { numRuns: 100, endOnFailure: true } as const;

/** Scope `all` checks the tree alone; scope `changed` checks it against the history's files. */
function verify(
  h: IssueHistory,
  head: Readonly<Record<string, string>>,
  scope: "all" | "changed",
  o: { readonly withBase?: boolean; readonly closeRequiresHuman?: boolean } = {},
): Promise<Finding[]> {
  return verifySnapshots({
    kind: COMPILED,
    layout: HISTORY_LAYOUT,
    base: (o.withBase ?? scope === "changed") ? new MemoryTree(h.files) : null,
    head: new MemoryTree(head),
    scope,
    checks: issueChecks({
      ...ISSUE_TEST_OPTIONS,
      closeRequiresHuman: o.closeRequiresHuman ?? false,
    }),
  });
}

const errors = (fs: readonly Finding[]) => fs.filter((f) => f.severity === "error");

/** The base history each mutation type samples from: weighted where a plain one rarely has a candidate. */
const baseFor = (type: IssueMutationType) =>
  type === "cycle-edge" || type === "of-at-duplicate" || type === "second-parent"
    ? arbIssueHistory({ subjects: { min: 2, max: 8 }, links: true, duplicates: true })
    : arbIssueHistory();

describe("verifier mutation", () => {
  it("never flags an untampered history", async () => {
    await fc.assert(
      fc.asyncProperty(arbIssueHistory({ links: true, duplicates: true }), async (h) => {
        for (const scope of scopes) {
          expect(errors(await verify(h, h.files, scope, { withBase: false }))).toEqual([]);
        }
      }),
      RUNS,
    );
  });

  for (const type of MUTATION_TYPES) {
    it(`flags ${type} with ${MUTATION_RULES[type].join(" or ")} in every scope`, async () => {
      await fc.assert(
        fc.asyncProperty(baseFor(type), fc.gen(), async (h, g) => {
          const arb = arbIssueMutation(h, { only: [type] });
          fc.pre(arb !== null);
          const m = g(() => arb);
          expect(m.type).toBe(type);
          const head = { ...h.files, [m.path]: m.content };
          for (const scope of scopes) {
            const found = await verify(h, head, scope, {
              closeRequiresHuman: type === "agent-close",
            });
            const hit = errors(found).some((f) =>
              (MUTATION_RULES[type] as readonly string[]).includes(f.rule),
            );
            expect(hit, JSON.stringify({ m, found }, null, 2)).toBe(true);
          }
          if (type === "cycle-edge") {
            expect(errors(await verify(h, head, "all")).map((f) => f.rule)).toEqual([
              "issue/cycle",
            ]);
          }
        }),
        RUNS,
      );
    });
  }

  for (const scope of scopes) {
    it(`flags ledger's tampers in scope ${scope}`, async () => {
      await fc.assert(
        fc.asyncProperty(
          arbIssueHistory().chain((h) => fc.tuple(fc.constant(h), arbTamper(h, { scope }))),
          async ([h, m]) => {
            const found = await verify(h, applyTamper(h.files, m), scope, { withBase: true });
            const hit = errors(found).some((f) => expectedRules[m.type].includes(f.rule));
            expect(hit, JSON.stringify({ m, found }, null, 2)).toBe(true);
          },
        ),
        RUNS,
      );
    });
  }

  for (const type of Object.keys(semanticExpectedRules) as (keyof typeof semanticExpectedRules)[]) {
    it(`flags ledger's semantic tamper ${type} in every scope`, async () => {
      await fc.assert(
        fc.asyncProperty(arbIssueHistory(), fc.gen(), async (h, g) => {
          const arb = arbSemanticTamper(h, {
            kind: issueKind,
            data: issueDataArbs(),
            only: [type],
          });
          fc.pre(arb !== null);
          const m = g(() => arb);
          const head = applySemanticTamper(h.files, m);
          for (const scope of scopes) {
            const found = await verify(h, head, scope);
            const hit = errors(found).some(
              (f) => semanticExpectedRules[type].includes(f.rule) && f.file === m.path,
            );
            expect(hit, JSON.stringify({ m, found }, null, 2)).toBe(true);
          }
        }),
        RUNS,
      );
    });
  }

  it("flags a modified event in a temp repo with verify --staged and --base", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbIssueHistory().chain((h) =>
          fc.tuple(fc.constant(h), arbTamper(h, { scope: "changed" })),
        ),
        async ([h, m]) => {
          fc.pre(m.type === "modify-event" || m.type === "delete-event");
          await using repo = await createTempRepo({ files: h.files });
          const tampered = applyTamper(h.files, m);
          if (Object.hasOwn(tampered, m.path)) await repo.write(m.path, tampered[m.path] ?? "");
          else await repo.remove(m.path);
          await repo.stage(".");
          const gitOptions = { env: repo.env };
          const staged = await openIssueLog({ cwd: repo.root, reader: "index", gitOptions });
          const found = await verifyIssues(staged, { type: "staged" });
          expect(errors(found).some((f) => expectedRules[m.type].includes(f.rule))).toBe(true);
          await repo.commit("tamper");
          const work = await openIssueLog({ cwd: repo.root, gitOptions });
          const range = await verifyIssues(work, { type: "range", base: "HEAD~1", head: "HEAD" });
          expect(errors(range).some((f) => expectedRules[m.type].includes(f.rule))).toBe(true);
        },
      ),
      { numRuns: 20, endOnFailure: true },
    );
  }, 120_000);
});

describe("template lint", () => {
  it("lints open issues against their template, and not closed ones", async () => {
    const o = opened("aaaaaaaa", "Unfilled");
    const draft = "# Unfilled\n\n## Goal\n\n## Done when\n\n";
    const files = {
      [TEMPLATE_PATH]: TASK_V1,
      ...issueFiles([{ id: "aaaaaaaa", events: [o], body: draft }]),
    };
    const head = (extra: Record<string, string>) => new MemoryTree({ ...files, ...extra });
    const run = (tree: MemoryTree) =>
      verifySnapshots({
        kind: COMPILED,
        layout: HISTORY_LAYOUT,
        base: null,
        head: tree,
        scope: "all",
        checks: issueChecks(),
      });
    const open = await run(head({}));
    expect(errors(open).map((f) => f.rule)).toContain("template/section-empty");
    const closedFiles = issueFiles([
      {
        id: "aaaaaaaa",
        body: draft,
        events: [
          o,
          {
            ...o,
            id: "01M5WDAYS26S0P9NY5EZ1P095H",
            type: "closed",
            at: "2026-01-02T00:00:00Z",
            data: { resolution: "done" },
          },
        ],
      },
    ]);
    const closed = await run(new MemoryTree({ [TEMPLATE_PATH]: TASK_V1, ...closedFiles }));
    expect(errors(closed)).toEqual([]);
  });

  it("accepts a description without an optional section, and reports a missing required one", async () => {
    const run = (body: string) =>
      verifySnapshots({
        kind: COMPILED,
        layout: HISTORY_LAYOUT,
        base: null,
        head: new MemoryTree({
          [TEMPLATE_PATH]: TASK_V1,
          ...issueFiles([{ id: "aaaaaaaa", events: [opened("aaaaaaaa", "T")], body }]),
        }),
        scope: "all",
        checks: issueChecks(),
      });
    const template = (fs: readonly Finding[]) =>
      fs.filter((f) => f.rule.startsWith("template/")).map((f) => f.rule);
    expect(template(await run("# T\n\n## Goal\nG\n\n## Done when\nD\n"))).toEqual([]);
    expect(template(await run("# T\n\n## Done when\nD\n"))).toEqual(["template/section-missing"]);
  });
});
