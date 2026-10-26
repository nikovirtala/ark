import { NO_NUMBERING, projectLog } from "@nikovirtala/ledger";
import { describe, expect, it } from "vitest";
import { formatIssueNumber, issueKind, parseIssueNumber } from "../kind.js";
import {
  foldFiles,
  IDS,
  issueEvent,
  issueFiles,
  numberingOf,
  opened,
} from "../test-support/events.js";

const { A, B, C } = IDS;

describe("issue numbers", () => {
  it("formats with a ? prefix", () => {
    expect(formatIssueNumber(1)).toBe("?1");
    expect(formatIssueNumber(42)).toBe("?42");
  });

  it("parses the bare number, ?42 and leading zeros", () => {
    const cases: [string, number | null][] = [
      ["42", 42],
      ["?42", 42],
      ["0042", 42],
      ["?0042", 42],
      [" 42 ", 42],
      ["?0", null],
      ["0", null],
      ["x", null],
      ["#42", null],
      ["??42", null],
      ["ADR-0042", null],
      ["123456789", 123456789],
      ["1234567890", null],
    ];
    for (const [input, n] of cases) expect(parseIssueNumber(input), input).toBe(n);
  });
});

describe("the view", () => {
  const files = () =>
    issueFiles([
      {
        id: A,
        body: "intro\n# Retitled  \n\n## Goal\nx\n",
        events: [
          issueEvent(A, "opened", {
            data: { title: "Original", template: "task", template_version: 1, parent: B },
            at: "2026-10-20T09:00:00Z",
          }),
          issueEvent(A, "assigned", {
            data: { set: ["a@example.com"] },
            at: "2026-10-20T09:01:00Z",
          }),
          issueEvent(A, "labeled", { data: { set: ["type:bug"] }, at: "2026-10-20T09:02:00Z" }),
          issueEvent(A, "scoped", { data: { set: ["src/**"] }, at: "2026-10-20T09:03:00Z" }),
          issueEvent(A, "commented", { data: { text: "one" }, at: "2026-10-20T09:04:00Z" }),
          issueEvent(A, "linked", {
            data: { to: C, rel: "relates-to" },
            at: "2026-10-20T09:05:00Z",
          }),
          issueEvent(A, "linked", {
            data: { to: "adr:k3f9q8a1", rel: "implements" },
            at: "2026-10-20T09:06:00Z",
          }),
          issueEvent(A, "started", { at: "2026-10-21T09:00:00Z" }),
          issueEvent(A, "closed", { data: { resolution: "done" }, at: "2026-10-22T09:00:00Z" }),
        ],
      },
      {
        id: B,
        body: "# \n",
        events: [
          issueEvent(B, "opened", {
            data: { title: "Parent", template: "task", template_version: 1 },
          }),
        ],
      },
      { id: C, body: null, events: [opened(C, "No body")] },
    ]);

  it("projects every field", async () => {
    const log = await foldFiles(files());
    const p = projectLog(issueKind, log, { numbering: numberingOf({ [A]: 1, [B]: 2 }) });
    expect(p.views.get(A)).toEqual({
      id: A,
      number: 1,
      display: "?1",
      title: "Retitled",
      state: "closed",
      resolution: "done",
      duplicate_of: null,
      canonical: A,
      duplicates: [],
      assignees: ["a@example.com"],
      labels: ["type:bug"],
      parent: B,
      children: [],
      depends_on: [],
      blocks: [],
      blocked_by_open: [],
      blocked: false,
      ready: false,
      relates_to: [C],
      implements: ["adr:k3f9q8a1"],
      applies_to: ["src/**"],
      comments: 1,
      template: { name: "task", version: 1 },
      body_path: `docs/issues/items/${A}.md`,
      opened_at: "2026-10-20T09:00:00Z",
      closed_at: "2026-10-22T09:00:00Z",
      state_at: "2026-10-22T09:00:00Z",
      history: ["opened 2026-10-20", "started 2026-10-21", "closed 2026-10-22"],
    });
    expect(p.views.get(B)).toMatchObject({ title: "Parent", children: [A], display: "?2" });
    expect(p.views.get(C)).toMatchObject({
      title: "No body",
      body_path: null,
      display: C,
      number: null,
    });
  });

  it("takes the title from the body's # heading, else the opened title", async () => {
    const log = await foldFiles(files());
    const p = projectLog(issueKind, log, { numbering: NO_NUMBERING });
    expect(p.views.get(A)?.title).toBe("Retitled");
    expect(p.views.get(B)?.title).toBe("Parent");
  });

  it("clears the resolution on reopen", async () => {
    const log = await foldFiles(
      issueFiles([
        {
          id: A,
          events: [
            opened(A),
            issueEvent(A, "closed", { data: { resolution: "wontfix" }, reason: "no" }),
            issueEvent(A, "reopened", { reason: "yes" }),
          ],
        },
      ]),
    );
    const v = projectLog(issueKind, log, { numbering: NO_NUMBERING }).views.get(A);
    expect(v).toMatchObject({ state: "open", resolution: null, closed_at: null, ready: true });
  });
});
