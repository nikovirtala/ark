import { afterEach, describe, expect, it } from "vitest";
import { compileKind } from "../envelope/kind.js";
import type { EventEnvelope } from "../envelope/types.js";
import { serializeEvent } from "../envelope/yaml.js";
import type { Finding } from "../findings/finding.js";
import { MemoryTree } from "../git/tree.js";
import { bodySha256 } from "../identity/hash.js";
import { eventPath } from "../identity/layout.js";
import { createUlidFactory } from "../identity/ulid.js";
import { defineKind, eventType } from "../kind/define.js";
import { treeTemplates } from "../templates/source.js";
import { TEST_HUMAN } from "../testing/history.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { foldChecks } from "./fold-checks.js";
import { templateCheck, templateHistoryRef } from "./template-check.js";
import { verifySnapshots } from "./verify.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});

/** Drafts are linted against their template; finalizing one lints it once more. */
const note = defineKind({
  name: "note",
  schema: "note/v1",
  states: ["draft", "final"],
  events: {
    created: eventType<{ template: string; template_version: number }>()({
      data: { type: "object" },
      allowedIn: [],
      to: "draft",
    }),
    finalized: eventType<{ body_sha256: string }>()({
      data: { type: "object" },
      allowedIn: ["draft"],
      to: "final",
    }),
  },
  initial: "created",
  reduce: () => null,
  project: (s) => s.id,
  body: { freezeOn: "finalized" },
  layout: { bodies: "notes", events: "events" },
  defaultRoot: "log",
  templates: {
    dir: "templates",
    nameField: "template",
    versionField: "template_version",
    lintIn: ["draft"],
    lintOn: "finalized",
    requireSections: ["context"],
  },
  options: undefined,
});

const layout = note.layoutAt("log");
const TEMPLATE = "log/templates/lite.md";
const template = (o: { version?: number; required?: boolean } = {}) => `---
template: lite
version: ${o.version ?? 1}
sections:
  - id: context
    heading: Context
    required: ${o.required ?? true}
    guidance: Describe the forces.
---
# {{title}}

## Context
{{context}}
`;
const GOOD = "# Title\n\n## Context\nThe forces.\n";
const EMPTY = "# Title\n\n## Context\n\n";
const hash = (text: string) => bodySha256(new TextEncoder().encode(text));
const bodyPath = (id: string) => `log/notes/${id}.md`;
const A = "a7c2m9xd";
const B = "k3f9q8a1";

let rand = 0;
function ev(subject: string, type: string, at: string, data: Record<string, unknown>) {
  const r = ++rand;
  const id = createUlidFactory({ now: () => Date.parse(at), random: (b) => b.fill(r) })();
  const e: EventEnvelope = {
    envelope: "ledger/v1",
    kind: "note",
    schema: "note/v1",
    id,
    subject,
    type,
    at,
    actor: TEST_HUMAN,
    data,
  };
  return e;
}
const file = (...es: EventEnvelope[]) =>
  Object.fromEntries(es.map((e) => [eventPath(layout, e), serializeEvent(e)]));
const created = (subject: string, data: Record<string, unknown> = {}) =>
  ev(subject, "created", "2026-01-01T00:00:00Z", {
    template: "lite",
    template_version: 1,
    ...data,
  });
const finalized = (subject: string, body: string) =>
  ev(subject, "finalized", "2026-01-02T00:00:00Z", { body_sha256: hash(body) });

function verify(
  before: Record<string, string | Uint8Array> | null,
  after: Record<string, string | Uint8Array>,
  scope: "all" | "changed" = "all",
): Promise<Finding[]> {
  return verifySnapshots({
    kind: compileKind(note),
    layout,
    base: before === null ? null : new MemoryTree(before),
    head: new MemoryTree(after),
    scope,
    checks: foldChecks(note, { templates: treeTemplates }),
  });
}
const brief = (fs: readonly Finding[]) => fs.map((f) => [f.rule, f.file, f.subject]);

describe("templateCheck", () => {
  it("lints bodies in a lintIn status against their template", async () => {
    const head = { [TEMPLATE]: template(), ...file(created(A)), [bodyPath(A)]: GOOD };
    expect(await verify(null, head)).toEqual([]);
    const findings = await verify(null, { ...head, [bodyPath(A)]: EMPTY });
    expect(brief(findings)).toEqual([["template/section-empty", bodyPath(A), A]]);
    expect(findings[0]?.kind).toBe("note");
  });

  it("doesn't re-lint bodies outside lintIn in a full check", async () => {
    const a = created(A);
    const head = { [TEMPLATE]: template(), ...file(a, finalized(A, EMPTY)), [bodyPath(A)]: EMPTY };
    expect(await verify(null, head)).toEqual([]);
    expect(await verify(head, head)).toEqual([]);
  });

  it("lints a body whose lintOn event is new against a base", async () => {
    const draft = { [TEMPLATE]: template(), ...file(created(A)), [bodyPath(A)]: GOOD };
    const base = { ...draft, [bodyPath(A)]: EMPTY };
    const head = { ...base, ...file(finalized(A, EMPTY)) };
    for (const scope of ["all", "changed"] as const) {
      expect(brief(await verify(base, head, scope))).toEqual([
        ["template/section-empty", bodyPath(A), A],
      ]);
    }
    expect(await verify(draft, { ...draft, ...file(finalized(A, GOOD)) })).toEqual([]);
  });

  it("reports a missing template, a missing version and a body that isn't UTF-8", async () => {
    const head = {
      [TEMPLATE]: template(),
      ...file(created(A, { template: "nygard" }), created(B, { template_version: 2 })),
      [bodyPath(A)]: GOOD,
      [bodyPath(B)]: GOOD,
    };
    const findings = await verify(null, head);
    expect(brief(findings)).toEqual([
      ["template/not-found", bodyPath(A), A],
      ["template/version-not-found", bodyPath(B), B],
    ]);
    expect(findings.map((f) => f.message)).toEqual([
      "template nygard not found at log/templates/nygard.md",
      `template lite has no version 2 at ${TEMPLATE}`,
    ]);
    const unnamed = await verify(null, {
      ...file(ev(A, "created", "2026-01-01T00:00:00Z", {})),
      [bodyPath(A)]: GOOD,
    });
    expect(brief(unnamed)).toEqual([["template/not-found", bodyPath(A), A]]);
    const binary = await verify(null, {
      [TEMPLATE]: template(),
      ...file(created(A)),
      [bodyPath(A)]: new Uint8Array([0x23, 0xff]),
    });
    expect(brief(binary)).toEqual([["body/not-utf8", bodyPath(A), A]]);
  });

  it("syntax-lints every template in scope all and the changed ones in scope changed", async () => {
    const base = { [TEMPLATE]: template(), "log/templates/broken.md": "no frontmatter\n" };
    expect(brief(await verify(null, base))).toEqual([
      ["template/frontmatter", "log/templates/broken.md", null],
    ]);
    expect(await verify(base, base, "changed")).toEqual([]);
    const head = { ...base, [TEMPLATE]: template({ version: 2, required: false }) };
    expect(brief(await verify(base, head, "changed"))).toEqual([
      ["template/required-section", TEMPLATE, null],
    ]);
    expect(brief(await verify(base, head, "all"))).toEqual([
      ["template/frontmatter", "log/templates/broken.md", null],
      ["template/required-section", TEMPLATE, null],
    ]);
  });

  it("returns nothing without a template source", async () => {
    const head = { ...file(created(A, { template: "nygard" })), [bodyPath(A)]: GOOD };
    const findings = await verifySnapshots({
      kind: compileKind(note),
      layout,
      base: null,
      head: new MemoryTree(head),
      scope: "all",
      checks: [templateCheck(null)],
    });
    expect(findings).toEqual([]);
    expect(
      await verifySnapshots({
        kind: compileKind(note),
        layout,
        base: null,
        head: new MemoryTree(head),
        scope: "all",
      }),
    ).toEqual([]);
  });
});

describe("templateHistoryRef", () => {
  it("is the mode's head ref, else HEAD, else null on an unborn HEAD", async () => {
    const r = await createTempRepo();
    repos.push(r);
    expect(await templateHistoryRef(r.git, { type: "staged" })).toBeNull();
    expect(await templateHistoryRef(r.git, { type: "full" })).toBeNull();
    expect(await templateHistoryRef(r.git, { type: "full", head: "main" })).toBe("main");
    await r.write("a.txt", "a\n");
    await r.stage("a.txt");
    await r.commit("a");
    expect(await templateHistoryRef(r.git, { type: "staged" })).toBe("HEAD");
    expect(await templateHistoryRef(r.git, { type: "range", base: "main" })).toBe("HEAD");
    expect(await templateHistoryRef(r.git, { type: "range", base: "main", head: "x" })).toBe("x");
  });
});
