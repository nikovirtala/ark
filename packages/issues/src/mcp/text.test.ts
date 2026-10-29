import { type Finding, MemoryTree, NO_NUMBERING, type Numbering } from "@nikovirtala/ledger";
import { describe, expect, it } from "vitest";
import { DEFAULT_ISSUES_CONFIG } from "../config.js";
import { type IssuesRead, readIssuesFrom } from "../log.js";
import {
  IDS,
  issueEvent,
  issueFiles,
  LAYOUT,
  numberingOf,
  type SubjectSpec,
} from "../test-support/events.js";
import type { IssueWriteJson } from "../write.js";
import { issueUri } from "./resources.js";
import { mcpHeader, writeText } from "./text.js";

const { A, B, C, D, E, F } = IDS;

const at = (n: number) => `2026-10-2${n}T09:00:00Z`;
const event = (id: string, type: string, n: number, o: Parameters<typeof issueEvent>[2] = {}) =>
  issueEvent(id, type, { ...o, at: at(n) });
const openedAt = (id: string, n: number) =>
  event(id, "opened", n, { data: { title: `Issue ${id}`, template: "task", template_version: 1 } });

const readOf = (subjects: SubjectSpec[], numbering: Numbering = NO_NUMBERING) =>
  readIssuesFrom(new MemoryTree(issueFiles(subjects)), {
    layout: LAYOUT,
    issues: DEFAULT_ISSUES_CONFIG,
    numbering,
    sources: null,
  });

const SUBJECTS: SubjectSpec[] = [
  {
    id: A,
    events: [
      openedAt(A, 1),
      event(A, "closed", 2, { data: { resolution: "duplicate", of: B }, reason: "same" }),
    ],
  },
  { id: B, events: [openedAt(B, 1), event(B, "started", 2)] },
  {
    id: C,
    events: [
      openedAt(C, 1),
      event(C, "closed", 2, { data: { resolution: "obsolete" }, reason: "replaced" }),
    ],
  },
  {
    id: D,
    events: [
      openedAt(D, 1),
      event(D, "linked", 2, { data: { to: B, rel: "depends-on" } }),
      event(D, "linked", 2, { data: { to: E, rel: "depends-on" } }),
      event(D, "linked", 2, { data: { to: C, rel: "depends-on" } }),
    ],
  },
  { id: E, events: [openedAt(E, 1)] },
  {
    id: F,
    events: [
      openedAt(F, 1),
      event(F, "closed", 2, { data: { resolution: "duplicate", of: E }, reason: "same" }),
    ],
  },
];

const header = (read: IssuesRead, id: string) => {
  const v = read.projection.views.get(id);
  if (v === undefined) throw new Error(id);
  return mcpHeader(v, read);
};

describe("mcpHeader", () => {
  it("points a duplicate at issues://issue/<number>, or the id when unnumbered", async () => {
    const read = await readOf(SUBJECTS, numberingOf({ [A]: 1, [B]: 2, [C]: 3, [D]: 4, [F]: 6 }));
    expect(header(read, A)).toEqual({
      line: `?1 (${A}) · closed`,
      warning: "DUPLICATE of ?2 (in-progress). Track work on ?2; read issues://issue/2.",
    });
    expect(header(read, F).warning).toBe(
      `DUPLICATE of ${E} (open). Track work on ${E}; read issues://issue/${E}.`,
    );
    expect(issueUri(read)(B)).toBe("issues://issue/2");
    expect(issueUri(read)(E)).toBe(`issues://issue/${E}`);
  });

  it("lists every open blocker, and carries a closed issue's reason", async () => {
    const read = await readOf(SUBJECTS, numberingOf({ [A]: 1, [B]: 2, [C]: 3, [D]: 4 }));
    expect(header(read, D)).toEqual({
      line: `?4 (${D}) · open`,
      warning: `BLOCKED by ?2 (in-progress), ${E} (open). Finish them first.`,
    });
    expect(header(read, C).warning).toBe("CLOSED on 2026-10-22 as obsolete: replaced.");
    expect(header(read, E)).toEqual({ line: `${E} · open`, warning: null });
  });

  it("uses ids everywhere without numbers", async () => {
    const read = await readOf(SUBJECTS);
    expect(header(read, A).warning).toBe(
      `DUPLICATE of ${B} (in-progress). Track work on ${B}; read issues://issue/${B}.`,
    );
  });
});

const finding = (rule: string, message: string, severity: "error" | "warning" = "error"): Finding =>
  ({ rule, message, severity, file: "docs/issues/items/x.md", line: null, subject: B }) as Finding;

describe("writeText", () => {
  const numbering = numberingOf({ [A]: 1, [B]: 2, [C]: 3, [D]: 4 });
  const write = async (
    d: Partial<IssueWriteJson>,
    o: Partial<Parameters<typeof writeText>[1]> = {},
  ) => {
    const read = await readOf(SUBJECTS, numbering);
    const doc: IssueWriteJson = {
      format: "issues-write/v1",
      command: "comment",
      ok: true,
      issue: read.projection.views.get(B) ?? null,
      affected: [],
      written: ["docs/issues/events/x.json"],
      commit: null,
      findings: [],
      notes: [],
      ...d,
    };
    return writeText(doc, { read, tool: "issues_comment", ...o });
  };

  it("says what was written and how, then lint, warnings and notes", async () => {
    const opened = await write(
      {
        command: "new",
        written: ["a", "b", "c"],
        findings: [
          finding("template/section-empty", "required section Done when is empty"),
          finding("issue/started-blocked", "?2 is blocked", "warning"),
        ],
        notes: ["on_behalf_of taken from the git identity x@example.com"],
      },
      { tool: "issues_open" },
    );
    expect(opened.headers).toEqual([{ line: `?2 (${B}) · in-progress`, warning: null }]);
    expect(opened.text.split("\n")).toEqual([
      `Opened ?2 (${B}): Issue ${B}`,
      `  docs/issues/items/${B}.md`,
      "Staged 3 files",
      "Fill in: Done when (required section Done when is empty)",
      "Warning: ?2 is blocked [issue/started-blocked]",
      "Note: on_behalf_of taken from the git identity x@example.com",
    ]);
    const updated = await write(
      { command: "edit", commit: "0123456789abcdef" },
      { tool: "issues_update", sections: ["goal", "done"], title: true },
    );
    expect(updated.text).toBe(`Updated ?2 (${B}): goal, done, title\nCommitted 0123456`);
    expect((await write({})).text).toBe(`Commented on ?2 (${B})\nStaged 1 file`);
    expect((await write({ command: "start" })).text.split("\n")[0]).toBe(`Started ?2 (${B})`);
    expect((await write({ command: "stop" })).text.split("\n")[0]).toBe(`Stopped ?2 (${B})`);
    const read = await readOf(SUBJECTS, numbering);
    const dup = await write({
      command: "close",
      issue: read.projection.views.get(A) ?? null,
      affected: [read.projection.views.get(B)].filter((v) => v !== undefined),
    });
    expect(dup.text.split("\n")[0]).toBe(`Closed ?1 (${A}) as a duplicate of ?2`);
    const obsolete = await write({ command: "close", issue: read.projection.views.get(C) ?? null });
    expect(obsolete.text.split("\n")[0]).toBe(`Closed ?3 (${C}) as obsolete`);
    const linked = await write(
      { command: "link", affected: [read.projection.views.get(D)].filter((v) => v !== undefined) },
      { rel: "depends-on", to: D },
    );
    expect(linked.text.split("\n")[0]).toBe(`Linked ?2 (${B}) depends-on ?4`);
    const unlinked = await write({ command: "unlink" }, { rel: "implements", to: "ADR-0012" });
    expect(unlinked.text.split("\n")[0]).toBe(`Unlinked ?2 (${B}) implements ADR-0012`);
    expect((await write({ command: "label" })).text.split("\n")[0]).toBe(
      `Labels of ?2 (${B}): none`,
    );
    expect((await write({ command: "assign" })).text.split("\n")[0]).toBe(
      `Assignees of ?2 (${B}): none`,
    );
    expect((await write({ command: "scope" })).text.split("\n")[0]).toBe(
      `Scope of ?2 (${B}): none`,
    );
    const unchanged = await write({ written: [], notes: ["nothing changed"] });
    expect(unchanged.text).toBe(`Unchanged: ?2 (${B})\nNote: nothing changed`);
    const unnumbered = await write({
      issue: (await readOf(SUBJECTS)).projection.views.get(E) ?? null,
    });
    expect(unnumbered.text).toBe(`Commented on ${E}\nStaged 1 file`);
  });

  it("lists a refusal's findings with the hint of its first rule", async () => {
    const lint = finding("template/section-empty", "required section Done when is empty");
    const refused = await write(
      { command: "new", ok: false, issue: null, written: [], findings: [lint] },
      { tool: "issues_open" },
    );
    expect(refused.headers).toEqual([]);
    expect(refused.text.split("\n")).toEqual([
      "Refused:",
      "  docs/issues/items/x.md: required section Done when is empty [template/section-empty]",
      "Fill in every required section and call issues_open again.",
    ]);
    const closed = await write({
      command: "close",
      ok: false,
      written: [],
      findings: [
        finding("issue/agent-closed", "closed by agent kiro"),
        finding("issue/agent-reason-required", "no reason"),
      ],
      notes: ["n"],
    });
    expect(closed.headers).toHaveLength(1);
    expect(closed.text.split("\n").slice(-2)).toEqual([
      "The issue log's policy keeps closing to people: tell the user the issue is ready to close and how each Done when condition was met.",
      "Note: n",
    ]);
    const reason = await write({
      command: "close",
      ok: false,
      written: [],
      findings: [finding("issue/agent-reason-required", "no reason")],
    });
    expect(reason.text.split("\n").at(-1)).toBe(
      "Call issues_close again with a reason that says how each Done when condition was met.",
    );
    const illegal = await write({
      command: "close",
      ok: false,
      written: [],
      findings: [
        { ...finding("transition/illegal", "closed is not allowed while closed"), file: null },
      ],
    });
    expect(illegal.text).toBe(
      "Refused:\n  closed is not allowed while closed [transition/illegal]",
    );
  });
});
