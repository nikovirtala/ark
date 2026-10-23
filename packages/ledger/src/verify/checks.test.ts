import { describe, expect, it } from "vitest";
import { compileKind, type KindSchema } from "../envelope/kind.js";
import type { EventEnvelope } from "../envelope/types.js";
import { serializeEvent } from "../envelope/yaml.js";
import { InvalidArgumentError } from "../errors.js";
import { type Finding, finding } from "../findings/finding.js";
import { MemoryTree } from "../git/tree.js";
import { bodySha256 } from "../identity/hash.js";
import { eventPath } from "../identity/layout.js";
import { defineKind, eventType } from "../kind/define.js";
import { loadLog } from "../log/snapshot.js";
import { exampleKind, exampleLayout as layout } from "../testing/example-kind.js";
import { type Check, type CheckContext, mechanicalChecks } from "./checks.js";
import { diffTrees } from "./diff.js";
import { verifySnapshots } from "./verify.js";

const kind = compileKind(exampleKind);
const S = "a7c2m9xd";
const T = "k3f9q8a1";
const BODY = "# Widget\n\nBody text.\n";
const BODY_PATH = `log/items/${S}-widget.md`;
const hash = (text: string) => bodySha256(new TextEncoder().encode(text));

const event = (o: Partial<EventEnvelope> = {}): EventEnvelope => ({
  envelope: "ledger/v1",
  kind: "widget",
  schema: "widget/v1",
  id: "01JAB3K9Z6Q8M2X7FQ0V4TQ8A1",
  subject: S,
  type: "created",
  at: "2026-03-14T12:02:11Z",
  actor: { kind: "human", name: "Ada" },
  data: { title: "A widget" },
  ...o,
});
const created = event();
const frozen = event({
  id: "01JAB3K9Z6Q8M2X7FQ0V4TFRZ1",
  type: "frozen",
  at: "2026-03-15T08:00:00Z",
  data: { body_sha256: hash(BODY) },
});
const file = (e: EventEnvelope) => ({ [eventPath(layout, e)]: serializeEvent(e) });
const CREATED = eventPath(layout, created);
const FROZEN = eventPath(layout, frozen);
const base: Record<string, string> = { ...file(created), ...file(frozen), [BODY_PATH]: BODY };

function verify(
  before: Record<string, string> | null,
  after: Record<string, string>,
  o: { scope?: "all" | "changed"; kind?: KindSchema; checks?: readonly Check[] } = {},
): Promise<Finding[]> {
  return verifySnapshots({
    kind: o.kind === undefined ? kind : compileKind(o.kind),
    layout,
    base: before === null ? null : new MemoryTree(before),
    head: new MemoryTree(after),
    scope: o.scope ?? "all",
    ...(o.checks === undefined ? {} : { checks: o.checks }),
  });
}
const brief = (fs: readonly Finding[]) => fs.map((f) => [f.rule, f.file, f.subject]);
const both = ["all", "changed"] as const;

describe("verifySnapshots", () => {
  for (const scope of both) {
    it(`finds nothing when nothing changed (scope ${scope})`, async () => {
      expect(await verify(base, base, { scope })).toEqual([]);
    });

    it(`reports a modified event as append-only/modified (scope ${scope})`, async () => {
      const head = { ...base, [CREATED]: serializeEvent(event({ data: { title: "Other" } })) };
      expect(await verify(base, head, { scope })).toEqual([
        finding({
          severity: "error",
          rule: "append-only/modified",
          message: "event file was modified; event files are append-only",
          file: CREATED,
          subject: S,
          kind: "widget",
        }),
      ]);
    });

    it(`reports a deleted event as append-only/deleted (scope ${scope})`, async () => {
      const { [CREATED]: _, ...head } = base;
      expect(brief(await verify(base, head, { scope }))).toEqual([
        ["append-only/deleted", CREATED, S],
      ]);
    });
  }

  it("reports a renamed event as a deletion plus the mismatch at the new path", async () => {
    const { [CREATED]: content = "", ...rest } = base;
    const moved = `log/events/${T}/20260314T120211Z-q8a1-created.yaml`;
    expect(brief(await verify(base, { ...rest, [moved]: content }))).toEqual([
      ["append-only/deleted", CREATED, S],
      ["identity/subject-mismatch", moved, T],
    ]);
  });

  it("allows removing a misplaced file", async () => {
    const before = { ...base, "log/events/README.md": "x" };
    expect(brief(await verify(before, before))).toEqual([
      ["identity/invalid-subject-dir", "log/events/README.md", null],
    ]);
    expect(await verify(before, base)).toEqual([]);
  });

  it("reports a freeze event without a valid hash as body/missing-hash", async () => {
    const bad = event({ id: "01JAB3K9Z6Q8M2X7FQ0V4TFRZ2", type: "frozen", data: {} });
    const upper = event({
      id: "01JAB3K9Z6Q8M2X7FQ0V4TFRZ3",
      type: "frozen",
      data: { body_sha256: hash(BODY).toUpperCase() },
    });
    expect(brief(await verify(base, { ...base, ...file(bad), ...file(upper) }))).toEqual([
      ["body/missing-hash", eventPath(layout, bad), S],
      ["body/missing-hash", eventPath(layout, upper), S],
    ]);
  });

  it("checks the hash on every freeze event, not only the first", async () => {
    const later = event({
      id: "01JAB3K9Z6Q8M2X7FQ0V4TFRZ4",
      type: "frozen",
      at: "2026-04-01T00:00:00Z",
      data: { body_sha256: hash("something else") },
    });
    for (const scope of both) {
      expect(brief(await verify(base, { ...base, ...file(later) }, { scope }))).toEqual([
        ["body/hash-mismatch", eventPath(layout, later), S],
      ]);
    }
  });

  it("reports a frozen subject without a body as body/missing", async () => {
    const { [BODY_PATH]: _, ...head } = base;
    const findings = await verify(null, head);
    expect(brief(findings)).toEqual([["body/missing", FROZEN, S]]);
    expect(findings[0]?.message).toBe(
      `body file is missing; it was frozen by frozen event ${frozen.id}`,
    );
  });

  it("reports an edited frozen body as body/frozen-modified and body/hash-mismatch", async () => {
    for (const scope of both) {
      const findings = await verify(base, { ...base, [BODY_PATH]: `${BODY}more\n` }, { scope });
      expect(brief(findings)).toEqual([
        ["body/hash-mismatch", FROZEN, S],
        ["body/frozen-modified", BODY_PATH, S],
      ]);
      expect(findings[1]?.message).toBe(
        `body changed after it was frozen by frozen event ${frozen.id}`,
      );
    }
  });

  it("ignores CRLF line endings in a frozen body", async () => {
    const crlf = BODY.replace(/\n/g, "\r\n");
    expect(await verify(base, { ...base, [BODY_PATH]: crlf })).toEqual([]);
  });

  it("reports a renamed frozen body as body/frozen-modified", async () => {
    const { [BODY_PATH]: body = "", ...rest } = base;
    const renamed = `log/items/${S}-renamed.md`;
    const findings = await verify(base, { ...rest, [renamed]: body });
    expect(brief(findings)).toEqual([["body/frozen-modified", renamed, S]]);
    expect(findings[0]?.message).toBe(
      `body renamed from ${BODY_PATH} after it was frozen by frozen event ${frozen.id}`,
    );
  });

  it("reports a deleted frozen body as body/frozen-deleted and body/missing", async () => {
    const { [BODY_PATH]: _, ...head } = base;
    for (const scope of both) {
      expect(brief(await verify(base, head, { scope }))).toEqual([
        ["body/missing", FROZEN, S],
        ["body/frozen-deleted", BODY_PATH, S],
      ]);
    }
  });

  it("lets a body change before the freeze, and under a mutable policy", async () => {
    const { [FROZEN]: _, ...unfrozen } = base;
    expect(await verify(unfrozen, { ...unfrozen, [BODY_PATH]: "new" })).toEqual([]);
    const mutable: KindSchema = { ...exampleKind, body: "mutable" };
    expect(await verify(base, { ...base, [BODY_PATH]: "new" }, { kind: mutable })).toEqual([]);
  });

  it("gives a frozen subject with two bodies only identity/duplicate-subject-id", async () => {
    const second = `log/items/${S}.md`;
    for (const scope of both) {
      expect(brief(await verify(base, { ...base, [second]: "x" }, { scope }))).toEqual([
        ["identity/duplicate-subject-id", BODY_PATH, S],
        ["identity/duplicate-subject-id", second, S],
      ]);
    }
  });

  it("makes no frozen-body comparison against a base with two bodies", async () => {
    const second = `log/items/${S}.md`;
    expect(await verify({ ...base, [second]: "x" }, base)).toEqual([]);
  });

  it("reports duplicate event ids in scope all, and among touched subjects when changed", async () => {
    const copy = event({ subject: T });
    const sameSubject = event({ at: "2026-03-14T12:02:12Z" });
    const cross = { ...base, ...file(copy) };
    expect(brief(await verify(base, cross))).toEqual([
      ["identity/duplicate-event-id", CREATED, S],
      ["identity/duplicate-event-id", eventPath(layout, copy), T],
    ]);
    expect(await verify(base, cross, { scope: "changed" })).toEqual([]);
    expect(
      brief(await verify(base, { ...base, ...file(sameSubject) }, { scope: "changed" })),
    ).toEqual([
      ["identity/duplicate-event-id", CREATED, S],
      ["identity/duplicate-event-id", eventPath(layout, sameSubject), S],
    ]);
  });

  it("reports structural findings only for added or modified paths in scope changed", async () => {
    const before = { ...base, "log/events/README.md": "x" };
    const after = { ...before, "log/events/NOTANID/x.yaml": "x", "log/items/foo.md": "x" };
    expect(brief(await verify(before, after, { scope: "changed" }))).toEqual([
      ["identity/invalid-subject-dir", "log/events/NOTANID/x.yaml", null],
      ["identity/body-file-name", "log/items/foo.md", null],
    ]);
    expect(brief(await verify(before, after))).toEqual([
      ["identity/invalid-subject-dir", "log/events/NOTANID/x.yaml", null],
      ["identity/invalid-subject-dir", "log/events/README.md", null],
      ["identity/body-file-name", "log/items/foo.md", null],
    ]);
  });

  it("reports every load rule of a touched subject", async () => {
    const after = {
      ...base,
      [`log/events/${S}/.gitkeep`]: "",
      [`log/events/${S}/broken.yaml`]: "a: [",
    };
    expect(brief(await verify(base, after, { scope: "changed" }))).toEqual([
      ["identity/stray-file", `log/events/${S}/.gitkeep`, S],
      ["identity/file-name", `log/events/${S}/broken.yaml`, S],
      ["event/unparseable", `log/events/${S}/broken.yaml`, S],
    ]);
  });

  it("reports deletions of a subject that is gone from head", async () => {
    expect(brief(await verify(base, {}, { scope: "changed" }))).toEqual([
      ["append-only/deleted", CREATED, S],
      ["append-only/deleted", FROZEN, S],
      ["body/frozen-deleted", BODY_PATH, S],
    ]);
  });

  it("runs extra checks after the mechanical ones, filling in the kind", async () => {
    const extra: Check = {
      id: "extra",
      run: (ctx) => [
        finding({ severity: "warning", rule: "test/extra", message: [...ctx.inScope].join(",") }),
      ],
    };
    expect(await verify(base, base, { checks: [...mechanicalChecks, extra] })).toEqual([
      finding({ severity: "warning", rule: "test/extra", message: S, kind: "widget" }),
    ]);
  });

  it("rejects a layout that doesn't match the body policy", async () => {
    const run = (k: KindSchema, bodies: string | null) =>
      verifySnapshots({
        kind: compileKind(k),
        layout: { ...layout, bodies },
        base: null,
        head: new MemoryTree({}),
        scope: "all",
      });
    await expect(run(exampleKind, null)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(run({ ...exampleKind, body: "none" }, "items")).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
  });
});

describe("checks without a fold", () => {
  it("run on a hand-built step-2 context that has no folded field", async () => {
    const head = { ...base, [BODY_PATH]: `${BODY}more\n` };
    const ctx: CheckContext = {
      kind,
      layout,
      base: await loadLog(new MemoryTree(base), { kind, layout }),
      head: await loadLog(new MemoryTree(head), { kind, layout }),
      changes: await diffTrees(new MemoryTree(base), new MemoryTree(head), layout.root),
      scope: "all",
      inScope: new Set([S]),
    };
    const findings: Finding[] = [];
    for (const check of mechanicalChecks) findings.push(...(await check.run(ctx)));
    expect(brief(findings)).toEqual([
      ["body/hash-mismatch", FROZEN, S],
      ["body/frozen-modified", BODY_PATH, S],
    ]);
  });
});

describe("bodyPolicy with a fold", () => {
  it("reports body/missing for a mutable kind's subject with events and no body", async () => {
    const mutable = defineKind({
      name: "widget",
      schema: "widget/v1",
      states: ["open"],
      events: {
        created: eventType()({ data: { type: "object" }, allowedIn: [], to: "open" }),
      },
      initial: "created",
      reduce: () => null,
      project: (s) => s.id,
      body: "mutable",
      layout: { bodies: "items", events: "events" },
      defaultRoot: "log",
      options: undefined,
    });
    const run = (files: Record<string, string>) =>
      verifySnapshots({
        kind: compileKind(mutable),
        layout,
        base: null,
        head: new MemoryTree(files),
        scope: "all",
      });
    const findings = await run(file(created));
    expect(brief(findings)).toEqual([["body/missing", CREATED, S]]);
    expect(findings[0]?.message).toBe("body file is missing");
    expect(await run({ ...file(created), [BODY_PATH]: "anything" })).toEqual([]);
  });
});
