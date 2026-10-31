import { describe, expect, it } from "vitest";
import { compileKind } from "../envelope/kind.js";
import type { EventEnvelope } from "../envelope/types.js";
import { serializeEvent } from "../envelope/yaml.js";
import { UsageError } from "../errors.js";
import { type Finding, finding } from "../findings/finding.js";
import { MemoryTree, type TreeReader } from "../git/tree.js";
import { eventPath } from "../identity/layout.js";
import { loadLog } from "../log/snapshot.js";
import { exampleKind, exampleLayout } from "../testing/example-kind.js";
import { TEST_HUMAN } from "../testing/history.js";
import {
  checkReason,
  checkText,
  chooseTemplate,
  eventFiles,
  eventPairs,
  findingKey,
  followRenamesChanges,
  MAX_TEXT_BYTES,
  newEvent,
  type PlanRead,
  precheck,
  refusal,
  type StagedRenames,
  subjectView,
  unmatchedGlobs,
} from "./write-plan.js";

const layout = exampleLayout;
const KIND = { name: "widget", schema: "widget/v1" } as const;
const S = "a7c2m9xd";
const T = "b8d3n0ye";
const BODY_PATH = `log/items/${S}.md`;
const decode = (b: Uint8Array | undefined) => new TextDecoder().decode(b);

function ev(subject: string, type: string, at: string, id: string): EventEnvelope {
  return {
    envelope: "ledger/v1",
    kind: "widget",
    schema: "widget/v1",
    id,
    subject,
    type,
    at,
    actor: TEST_HUMAN,
    data: type === "created" ? { title: "Gear" } : {},
  };
}

/** A `PlanRead` of the files in `files`, loaded with the example kind. */
async function planRead(files: Record<string, string>): Promise<PlanRead> {
  const snap = await loadLog(new MemoryTree(files), { kind: compileKind(exampleKind), layout });
  return {
    folded: { subjects: new Map([...snap.subjects].map(([id, loaded]) => [id, { loaded }])) },
    layout,
  };
}

const usage = (f: () => unknown, message: string) => {
  expect(f).toThrow(UsageError);
  expect(f).toThrow(message);
};

describe("checkText", () => {
  it("accepts text up to 64 KiB", () => {
    expect(() => checkText("--text", "a".repeat(MAX_TEXT_BYTES))).not.toThrow();
    expect(MAX_TEXT_BYTES).toBe(65_536);
  });

  it("refuses NUL characters and text over 64 KiB in UTF-8 bytes", () => {
    usage(
      () => checkText("the note text", "a\0b"),
      "the note text must not contain NUL characters",
    );
    usage(
      () => checkText("section scope", "é".repeat(MAX_TEXT_BYTES / 2 + 1)),
      "section scope is 65538 bytes; the limit is 65536 (64 KiB)",
    );
  });
});

describe("checkReason", () => {
  it("gives null without a reason and the trimmed reason otherwise", () => {
    expect(checkReason(undefined)).toBeNull();
    expect(checkReason(null)).toBeNull();
    expect(checkReason("  done  \n")).toBe("done");
  });

  it("refuses an empty reason and checks it as text", () => {
    usage(() => checkReason("  \t "), "--reason must not be empty");
    usage(() => checkReason("a\0"), "--reason must not contain NUL characters");
  });
});

describe("findingKey", () => {
  it("compares rule, subject, file and message only", () => {
    const f = finding({ severity: "error", rule: "r", message: "m", subject: S, file: "f" });
    expect(findingKey(f)).toBe(["r", S, "f", "m"].join("\0"));
    expect(findingKey({ ...f, severity: "warning", line: 3 })).toBe(findingKey(f));
    expect(findingKey(finding({ severity: "error", rule: "r", message: "m" }))).toBe("r\0\0\0m");
  });
});

describe("subjectView", () => {
  const projection = {
    views: new Map([[S, { id: S }]]),
    unreadable: [T],
  };
  const missing = (id: string) => `decision ${id} can't be read; run adr verify`;
  const unreadable = (id: string) => `decision ${id} uses a newer format; upgrade adr`;

  it("gives the folded view", () => {
    expect(subjectView(projection, S, { missing })).toEqual({ id: S });
  });

  it("names an unreadable subject when asked to, else says it's missing", () => {
    usage(
      () => subjectView(projection, T, { missing, unreadable }),
      "decision b8d3n0ye uses a newer format; upgrade adr",
    );
    usage(
      () => subjectView(projection, "c9e4p1zf", { missing, unreadable }),
      "decision c9e4p1zf can't be read; run adr verify",
    );
    usage(
      () =>
        subjectView(projection, T, {
          missing: (id) => `${id} has no valid opened event; run issues verify`,
        }),
      "b8d3n0ye has no valid opened event; run issues verify",
    );
  });
});

describe("refusal", () => {
  it("files the finding on the subject's body, else on its events directory", async () => {
    const created = ev(S, "created", "2026-01-01T00:00:00Z", "01JGFJJZ000000000000000000");
    const read = await planRead({
      [BODY_PATH]: "# Gear\n",
      [eventPath(layout, created)]: serializeEvent(created),
    });
    expect(refusal(read, "widget", "transition/illegal", "no", S)).toEqual({
      severity: "error",
      rule: "transition/illegal",
      message: "no",
      file: BODY_PATH,
      line: null,
      subject: S,
      kind: "widget",
    });
    expect(refusal(read, "widget", "transition/illegal", "no", T).file).toBe(`log/events/${T}`);
  });
});

describe("newEvent", () => {
  const random = (b: Uint8Array) => b.fill(7);

  it("builds an envelope of the kind that sorts after the subject's events and `after`", async () => {
    const first = ev(S, "created", "2026-01-01T00:00:05Z", "01JGFJJZ000000000000000000");
    const read = await planRead({ [eventPath(layout, first)]: serializeEvent(first) });
    const now = () => Date.parse("2026-01-01T00:00:00Z");
    const a = newEvent(read, { now, random }, KIND, {
      subject: S,
      type: "noted",
      data: { text: "x" },
      reason: "because",
      actor: TEST_HUMAN,
    });
    expect(a).toMatchObject({
      envelope: "ledger/v1",
      kind: "widget",
      schema: "widget/v1",
      subject: S,
      type: "noted",
      at: "2026-01-01T00:00:05Z",
      actor: TEST_HUMAN,
      reason: "because",
      data: { text: "x" },
    });
    expect(a.id > first.id).toBe(true);
    const b = newEvent(read, { now, random }, KIND, {
      subject: S,
      type: "noted",
      data: {},
      actor: TEST_HUMAN,
      after: [a],
    });
    expect(b.id > a.id).toBe(true);
  });

  it("leaves `reason` out when it is null or missing", async () => {
    const read = await planRead({});
    const now = () => Date.parse("2026-02-01T00:00:00Z");
    for (const reason of [{ reason: null }, {}]) {
      const e = newEvent(read, { now }, KIND, {
        subject: T,
        type: "created",
        data: { title: "Gear" },
        ...reason,
        actor: TEST_HUMAN,
      });
      expect(Object.hasOwn(e, "reason")).toBe(false);
      expect(e.at).toBe("2026-02-01T00:00:00Z");
    }
  });
});

describe("eventFiles and eventPairs", () => {
  const a = ev(S, "created", "2026-01-01T00:00:00Z", "01JGFJJZ000000000000000000");
  const b = ev(S, "noted", "2026-01-01T00:00:01Z", "01JGFJK0000000000000000000");
  const c = ev(S, "noted", "2026-01-01T00:00:02Z", "01JGFJK1000000000000000000");

  it("serializes each event at its path, in event order", () => {
    const files = eventFiles(layout, [b, a]);
    expect(Object.keys(files)).toEqual([eventPath(layout, b), eventPath(layout, a)]);
    expect(decode(files[eventPath(layout, a)])).toBe(serializeEvent(a));
  });

  it("gives one pair per event, repeated pairs included", () => {
    const keys = { subject: "Widget", event: "Widget-Event" };
    expect(eventPairs([a, b, c], keys)).toEqual([
      ["Widget", S],
      ["Widget-Event", "created"],
      ["Widget", S],
      ["Widget-Event", "noted"],
      ["Widget", S],
      ["Widget-Event", "noted"],
    ]);
    expect(eventPairs([], keys)).toEqual([]);
  });
});

describe("precheck", () => {
  const old = finding({ severity: "error", rule: "old", message: "was there", subject: S });

  it("refolds the overlay and returns only the findings the write adds", async () => {
    const tree = new MemoryTree({ "a.md": "a" });
    const seen: string[] = [];
    const refold = async (t: TreeReader) => {
      seen.push(
        decode((await t.read("a.md")) ?? undefined),
        decode((await t.read("b.md")) ?? undefined),
      );
      const added = finding({ severity: "warning", rule: "new", message: "added", subject: S });
      return { findings: [{ ...old, severity: "warning" } as Finding, added], tag: "after" };
    };
    const r = await precheck(
      { tree, findings: [old] },
      { "b.md": new TextEncoder().encode("b") },
      { "a.md": new TextEncoder().encode("A") },
      refold,
    );
    expect(seen).toEqual(["A", "b"]);
    expect(r.after.tag).toBe("after");
    expect(r.added.map((f) => f.rule)).toEqual(["new"]);
  });

  it("returns nothing added when the findings are unchanged", async () => {
    const r = await precheck({ tree: new MemoryTree({}), findings: [old] }, {}, {}, async () => ({
      findings: [old],
    }));
    expect(r.added).toEqual([]);
  });
});

describe("chooseTemplate", () => {
  const TEMPLATE = [
    "---",
    "template: basic",
    "version: 1",
    "sections:",
    "  - id: scope",
    "    heading: Scope",
    "    required: true",
    "---",
    "# {{title}}",
    "",
    "## Scope",
    "{{scope}}",
    "",
  ].join("\n");
  const builtins = {
    basic: TEMPLATE,
    other: TEMPLATE.replace("template: basic", "template: other"),
  };

  it("uses the repo's template and copies nothing", async () => {
    const tree = new MemoryTree({ "log/templates/basic.md": TEMPLATE });
    const r = await chooseTemplate(tree, "log", "basic", {}, ["scope"]);
    expect(r).toMatchObject({ ok: true, materialize: null, path: "log/templates/basic.md" });
    expect(r.ok && r.template.name).toBe("basic");
  });

  it("falls back to a built-in to materialize", async () => {
    const r = await chooseTemplate(new MemoryTree({}), "log", "basic", builtins, ["scope"]);
    expect(r).toMatchObject({ ok: true, materialize: TEMPLATE, path: "log/templates/basic.md" });
  });

  it("refuses an unknown or invalid name with UsageError", async () => {
    const tree = new MemoryTree({});
    await expect(chooseTemplate(tree, "log", "nope", builtins, [])).rejects.toThrow(
      new UsageError("unknown template nope; add log/templates/nope.md or use one of basic, other"),
    );
    for (const name of ["Basic", "1x", "a/b", `a${"b".repeat(64)}`]) {
      await expect(chooseTemplate(tree, "log", name, builtins, [])).rejects.toThrow(
        new UsageError(`invalid template name ${JSON.stringify(name)}`),
      );
    }
    await expect(chooseTemplate(tree, "log", "constructor", {}, [])).rejects.toThrow(
      "unknown template constructor",
    );
  });

  it("gives the parse and lint findings of a bad template", async () => {
    const lint = await chooseTemplate(new MemoryTree({}), "log", "basic", builtins, ["done"]);
    expect(lint).toEqual({
      ok: false,
      findings: [
        expect.objectContaining({
          rule: "template/required-section",
          message: "template basic must have a required done section",
        }),
      ],
    });
    const tree = new MemoryTree({ "log/templates/basic.md": "no front matter\n" });
    const parse = await chooseTemplate(tree, "log", "basic", builtins, []);
    expect(parse.ok).toBe(false);
    expect(!parse.ok && parse.findings.length).toBeGreaterThan(0);
  });
});

describe("unmatchedGlobs", () => {
  it("gives the globs no file matches, in input order", () => {
    expect(unmatchedGlobs(["src/**", "lib/*.ts", "docs/x.md"], ["src/a.ts", "README.md"])).toEqual([
      "lib/*.ts",
      "docs/x.md",
    ]);
    expect(unmatchedGlobs([], ["a"])).toEqual([]);
  });
});

describe("followRenamesChanges", () => {
  interface View {
    readonly id: string;
    readonly applies_to: readonly string[];
    readonly open: boolean;
  }
  const staged = (renames: StagedRenames["renames"], before: readonly string[]): StagedRenames => {
    const from = new Set(renames.map((r) => r.from));
    return {
      renames,
      before,
      after: [...before.filter((f) => !from.has(f)), ...renames.map((r) => r.to)],
    };
  };
  const named = (v: View) => `W-${v.id}`;
  const blocked = (v: View, leaving: number) =>
    v.open
      ? null
      : `${named(v)} is closed; its scope can't follow renames (${leaving} renamed files leave it)`;
  const change = (v: View, globs: readonly string[]) => ({ change: { id: v.id, set: globs } });

  it("skips unchanged views and collects changes in id order", () => {
    const s = staged([{ from: "src/a.ts", to: "lib/a.ts" }], ["src/a.ts", "README.md"]);
    const r = followRenamesChanges(
      [
        { id: "b", applies_to: ["src/a.ts"], open: true },
        { id: "c", applies_to: ["README.md"], open: false },
        { id: "a", applies_to: ["src/**"], open: true },
      ],
      s,
      { named, blocked, change },
    );
    expect(r).toEqual({
      ok: true,
      changes: [
        { id: "a", set: ["lib/**"] },
        { id: "b", set: ["lib/a.ts"] },
      ],
      notes: [],
    });
  });

  it("gives a blocked view's note with the count of renamed files leaving its scope", () => {
    const s = staged(
      [
        { from: "src/a.ts", to: "lib/a.ts" },
        { from: "src/b.ts", to: "lib/b.ts" },
        { from: "doc/x.md", to: "doc/y.md" },
      ],
      ["src/a.ts", "src/b.ts", "doc/x.md"],
    );
    const leavings: number[] = [];
    const r = followRenamesChanges([{ id: "a", applies_to: ["src/**"], open: false }], s, {
      named,
      blocked: (v, leaving) => {
        leavings.push(leaving);
        return blocked(v, leaving);
      },
      change,
    });
    expect(leavings).toEqual([2]);
    expect(r).toEqual({
      ok: true,
      changes: [],
      notes: ["W-a is closed; its scope can't follow renames (2 renamed files leave it)"],
    });
  });

  it("notes skipped and gained files of a changed view", () => {
    const s = staged(
      [
        { from: "src/c.ts", to: "lib/c.ts" },
        { from: "src/a.ts", to: "src/a\tb.ts" },
        { from: "other/x.ts", to: "app/x.ts" },
      ],
      ["src/a.ts", "src/c.ts", "other/x.ts"],
    );
    const r = followRenamesChanges(
      [{ id: "a", applies_to: ["src/a.ts", "src/c.ts", "app/**"], open: true }],
      s,
      { named, blocked, change },
    );
    expect(r).toEqual({
      ok: true,
      changes: [{ id: "a", set: ["app/**", "lib/c.ts", "src/a.ts"] }],
      notes: [
        "src/a\tb.ts can't be written as a scope glob (control-char); W-a no longer covers it",
        "app/x.ts is now covered by W-a's scope but wasn't before the rename; check it",
      ],
    });
  });

  it("refuses more than 200 globs with UsageError", () => {
    const files = Array.from({ length: 201 }, (_, i) => `src/f${i}.ts`);
    const renames = files.map((f) => ({ from: f, to: f.replace("src/", "lib/") }));
    const s = staged(renames, files);
    usage(
      () =>
        followRenamesChanges([{ id: "a", applies_to: files, open: true }], s, {
          named,
          blocked,
          change,
        }),
      "following the renames gives W-a 201 globs; the limit is 200",
    );
  });

  it("stops at a change's refusal, before a later view's 200-glob error", () => {
    const files = Array.from({ length: 201 }, (_, i) => `src/f${i}.ts`);
    const renames = files.map((f) => ({ from: f, to: f.replace("src/", "lib/") }));
    const s = staged(renames, files);
    const seen: string[] = [];
    const r = followRenamesChanges(
      [
        { id: "b", applies_to: files, open: true },
        { id: "a", applies_to: ["src/f0.ts"], open: true },
      ],
      s,
      {
        named,
        blocked,
        change: (v, globs) => {
          seen.push(v.id);
          return v.id === "a" ? { stop: `refused ${v.id}` } : change(v, globs);
        },
      },
    );
    expect(r).toEqual({ ok: false, stop: "refused a" });
    expect(seen).toEqual(["a"]);
  });
});
