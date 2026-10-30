import { MemoryTree, NO_NUMBERING, type Numbering, UsageError } from "@nikovirtala/ledger";
import { TEST_HUMAN } from "@nikovirtala/ledger/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_ISSUES_CONFIG, type IssuesConfig } from "./config.js";
import type { SourceLog } from "./kind.js";
import { type IssuesRead, readIssuesFrom } from "./log.js";
import { TEST_AGENT } from "./test-support/arbitraries.js";
import {
  IDS,
  issueEvent,
  issueFiles,
  LAYOUT,
  numberingOf,
  type SubjectSpec,
} from "./test-support/events.js";
import { arbIssueHistory } from "./test-support/history.js";
import {
  historyActor,
  listIssues,
  myAddress,
  readyIssues,
  showIssue,
  stateHeader,
} from "./views.js";

const { A, B, C, D, E, F, G } = IDS;

const at = (n: number) => `2026-10-2${n}T09:00:00Z`;
const event = (id: string, type: string, n: number, o: Parameters<typeof issueEvent>[2] = {}) =>
  issueEvent(id, type, { ...o, at: at(n) });
const openedAt = (id: string, n: number, title = `Issue ${id}`, parent?: string) =>
  event(id, "opened", n, {
    data: {
      title,
      template: "task",
      template_version: 1,
      ...(parent === undefined ? {} : { parent }),
    },
  });

async function readOf(
  subjects: SubjectSpec[],
  o: {
    numbering?: Numbering;
    issues?: Partial<IssuesConfig>;
    sources?: ReadonlyMap<string, SourceLog>;
  } = {},
): Promise<IssuesRead> {
  return readIssuesFrom(new MemoryTree(issueFiles(subjects)), {
    layout: LAYOUT,
    issues: { ...DEFAULT_ISSUES_CONFIG, ...o.issues },
    numbering: o.numbering ?? NO_NUMBERING,
    sources: o.sources ?? null,
  });
}

const ids = (doc: { issues: readonly { id: string }[] }) => doc.issues.map((v) => v.id);

describe("listIssues", () => {
  const log = () =>
    readOf(
      [
        { id: A, events: [openedAt(A, 1)] },
        { id: B, events: [openedAt(B, 1), event(B, "started", 2)] },
        {
          id: C,
          events: [openedAt(C, 1), event(C, "closed", 2, { data: { resolution: "done" } })],
        },
        {
          id: D,
          events: [
            openedAt(D, 0),
            event(D, "assigned", 1, { data: { set: ["Ann@Example.com"] } }),
            event(D, "labeled", 1, { data: { set: ["area:cli", "type:bug"] } }),
          ],
        },
        { id: E, events: [openedAt(E, 0)] },
      ],
      { numbering: numberingOf({ [A]: 2, [B]: 3, [C]: 1, [D]: 4 }) },
    );

  it("lists in-progress, then open issues by default, by number then opened_at", async () => {
    const doc = listIssues(await log());
    expect(ids(doc)).toEqual([B, A, D, E]);
    expect(doc.filter).toEqual({
      states: ["in-progress", "open"],
      assignees: [],
      labels: [],
      limit: null,
    });
    expect(doc.format).toBe("issues-list/v1");
    expect(doc.source).toBeNull();
  });

  it("takes --state (repeatable) and --all, but not both", async () => {
    const read = await log();
    expect(ids(listIssues(read, { states: ["closed"] }))).toEqual([C]);
    expect(ids(listIssues(read, { states: ["closed", "open"] }))).toEqual([A, D, E, C]);
    expect(ids(listIssues(read, { all: true }))).toEqual([B, A, D, E, C]);
    expect(() => listIssues(read, { all: true, states: ["open"] })).toThrow(UsageError);
  });

  it("AND-s assignees and labels, matching emails ignoring case", async () => {
    const read = await log();
    expect(ids(listIssues(read, { assignees: ["ann@example.com"] }))).toEqual([D]);
    expect(ids(listIssues(read, { labels: ["type:bug", "area:cli"] }))).toEqual([D]);
    expect(ids(listIssues(read, { labels: ["type:bug", "area:mcp"] }))).toEqual([]);
    expect(ids(listIssues(read, { assignees: ["ann"] }))).toEqual([]);
    expect(ids(listIssues(read, { limit: 2 }))).toEqual([B, A]);
  });
});

describe("showIssue", () => {
  const sources: ReadonlyMap<string, SourceLog> = new Map([
    ["platform", { kind: "issues", local: false, subjects: null }],
  ]);

  it("resolves references for display, lists comments and the history", async () => {
    const read = await readOf(
      [
        {
          id: A,
          events: [
            openedAt(A, 1, "Parent"),
            event(A, "linked", 2, { data: { to: B, rel: "depends-on" } }),
            event(A, "linked", 2, { data: { to: `platform:${F}`, rel: "relates-to" } }),
            event(A, "commented", 3, { data: { text: "first" } }),
            event(A, "commented", 4, { data: { text: "second" }, actor: TEST_AGENT }),
          ],
        },
        { id: B, events: [openedAt(B, 1, "Dependency")] },
        { id: C, events: [openedAt(C, 1, "Child", A)] },
      ],
      { numbering: numberingOf({ [A]: 1, [B]: 2 }), sources },
    );
    const doc = showIssue(read, A, { history: true });
    expect(doc.format).toBe("issues-show/v1");
    expect(doc.references).toEqual([
      {
        rel: "depends-on",
        to: B,
        display: "?2",
        title: "Dependency",
        status: "open",
        checked: true,
      },
      {
        rel: "relates-to",
        to: `platform:${F}`,
        display: `platform:${F}`,
        title: null,
        status: null,
        checked: false,
      },
      { rel: "child", to: C, display: C, title: "Child", status: "open", checked: true },
    ]);
    expect(doc.comments?.map((c) => [c.text, c.actor.kind])).toEqual([
      ["first", "human"],
      ["second", "agent"],
    ]);
    expect(doc.events?.map((e) => e.type)).toEqual([
      "opened",
      "linked",
      "linked",
      "commented",
      "commented",
    ]);
    expect(doc.body).toBe("# Parent\n");
    expect(doc.commits).toBeNull();
    const plain = showIssue(read, A, { comments: false });
    expect(plain.comments).toBeNull();
    expect(plain.events).toBeNull();
    expect(showIssue(read, C).references).toEqual([
      { rel: "parent", to: A, display: "?1", title: "Parent", status: "open", checked: true },
    ]);
  });

  it("shows decisions of the local log with their numbers and statuses", async () => {
    const read = await readOf([
      {
        id: A,
        events: [
          openedAt(A, 1),
          event(A, "linked", 2, { data: { to: "adr:k3f9q8a1", rel: "implements" } }),
        ],
      },
    ]);
    const withDecisions: IssuesRead = {
      ...read,
      decisions: {
        root: "docs/adr",
        configPath: null,
        numbering: numberingOf({ k3f9q8a1: 1 }),
        ids: new Set(["k3f9q8a1"]),
        views: new Map([
          ["k3f9q8a1", { display: "ADR-0001", title: "Use queues", status: "accepted" } as never],
        ]),
      },
    };
    expect(showIssue(withDecisions, A).references).toEqual([
      {
        rel: "implements",
        to: "adr:k3f9q8a1",
        display: "ADR-0001",
        title: "Use queues",
        status: "accepted",
        checked: true,
      },
    ]);
  });

  it("refuses unknown and unfoldable issues", async () => {
    const read = await readOf([{ id: A, events: [event(A, "started", 1)], body: "# A\n" }]);
    expect(() => showIssue(read, A)).toThrow("has no valid opened event");
    expect(() => showIssue(read, B)).toThrow(`unknown issue ${B}`);
  });
});

describe("stateHeader", () => {
  it("covers every state", async () => {
    const read = await readOf(
      [
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
            event(C, "closed", 2, { data: { resolution: "wontfix" }, reason: "not needed" }),
          ],
        },
        {
          id: D,
          events: [openedAt(D, 1), event(D, "closed", 2, { data: { resolution: "done" } })],
        },
        {
          id: E,
          events: [
            openedAt(E, 1),
            event(E, "linked", 2, { data: { to: B, rel: "depends-on" } }),
            event(E, "linked", 2, { data: { to: F, rel: "depends-on" } }),
          ],
        },
        { id: F, events: [openedAt(F, 1)] },
        {
          id: G,
          events: [openedAt(G, 1), event(G, "linked", 2, { data: { to: B, rel: "depends-on" } })],
        },
      ],
      { numbering: numberingOf({ [A]: 1, [B]: 2, [C]: 3, [D]: 4, [E]: 5 }) },
    );
    const h = (id: string, refer?: (id: string) => string) => {
      const v = read.projection.views.get(id);
      if (v === undefined) throw new Error(id);
      return stateHeader(v, read, refer === undefined ? {} : { refer });
    };
    expect(h(A)).toEqual({
      line: `?1 (${A}) · closed`,
      warning: "DUPLICATE of ?2 (in-progress). Track work on ?2; read ?2.",
    });
    expect(h(A, (id) => `issues://issue/${id}`).warning).toBe(
      `DUPLICATE of ?2 (in-progress). Track work on ?2; read issues://issue/${B}.`,
    );
    expect(h(C).warning).toBe("CLOSED on 2026-10-22 as won't fix: not needed.");
    expect(h(D).warning).toBe("CLOSED on 2026-10-22 as done.");
    expect(h(E).warning).toBe(`BLOCKED by ?2 (in-progress), ${F} (open). Finish them first.`);
    expect(h(G).warning).toBe("BLOCKED by ?2 (in-progress). Finish it first.");
    expect(h(F)).toEqual({ line: `${F} · open`, warning: null });
  });
});

describe("historyActor", () => {
  it("names on whose behalf an agent acted, when the event says", () => {
    expect(historyActor(TEST_HUMAN)).toBe("Test");
    expect(historyActor(TEST_AGENT)).toBe("test-agent on behalf of test@example.com");
    expect(historyActor({ ...TEST_AGENT, on_behalf_of: null })).toBe("test-agent");
  });
});

describe("readyIssues", () => {
  const subjects = (): SubjectSpec[] => [
    {
      id: A,
      events: [openedAt(A, 3), event(A, "labeled", 4, { data: { set: ["priority:low"] } })],
    },
    {
      id: B,
      events: [
        openedAt(B, 2),
        event(B, "labeled", 4, { data: { set: ["priority:high", "type:bug"] } }),
      ],
    },
    { id: C, events: [openedAt(C, 1)] },
    { id: D, events: [openedAt(D, 0)] },
    {
      id: E,
      events: [openedAt(E, 0), event(E, "assigned", 1, { data: { set: ["TEST@example.com"] } })],
    },
    { id: F, events: [openedAt(F, 0), event(F, "assigned", 1, { data: { set: ["test"] } })] },
  ];

  it("lists ready work by number, then opened_at and id, without assigned issues", async () => {
    const read = await readOf(subjects(), { numbering: numberingOf({ [C]: 1, [A]: 2 }) });
    expect(ids(readyIssues(read))).toEqual([C, A, D, B]);
  });

  it("orders by [labels] priority first, and filters by every --label", async () => {
    const read = await readOf(subjects(), {
      numbering: numberingOf({ [C]: 1, [A]: 2 }),
      issues: { priority: ["priority:high", "priority:low"] },
    });
    expect(ids(readyIssues(read))).toEqual([B, A, C, D]);
    expect(ids(readyIssues(read, { labels: ["type:bug"] }))).toEqual([B]);
    expect(ids(readyIssues(read, { limit: 1 }))).toEqual([B]);
  });

  it("--mine lists issues assigned to me first, matching emails ignoring case", async () => {
    const read = await readOf(subjects(), { numbering: numberingOf({ [C]: 1, [A]: 2 }) });
    const doc = readyIssues(read, { mine: "test@example.com" });
    expect(ids(doc)).toEqual([E, C, A, D, B]);
    expect(doc.filter).toEqual({ labels: [], mine: "test@example.com", limit: null });
    expect(ids(readyIssues(read, { mine: "test" }))).toEqual([F, C, A, D, B]);
  });

  it("--mine needs an address", () => {
    expect(myAddress(TEST_HUMAN)).toBe("test@example.com");
    expect(myAddress(TEST_AGENT)).toBe("test@example.com");
    expect(() => myAddress({ ...TEST_HUMAN, email: null })).toThrow(
      "--mine needs your email; set git config user.email",
    );
  });

  it("lists no blocked, assigned or closed issue and no issue with an open child (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbIssueHistory({ subjects: { min: 2, max: 8 }, links: true, duplicates: true }),
        async (h) => {
          const read = await readIssuesFrom(new MemoryTree(h.files), {
            layout: LAYOUT,
            issues: DEFAULT_ISSUES_CONFIG,
            numbering: NO_NUMBERING,
            sources: null,
          });
          const views = read.projection.views;
          for (const v of readyIssues(read).issues) {
            expect(v.state).toBe("open");
            expect(v.blocked).toBe(false);
            expect(v.assignees).toEqual([]);
            expect(v.children.every((c) => views.get(c)?.state === "closed")).toBe(true);
          }
          expect(ids(readyIssues(read)).sort()).toEqual(
            [...views.values()]
              .filter((v) => v.ready)
              .map((v) => v.id)
              .sort(),
          );
        },
      ),
      { numRuns: 200, endOnFailure: true },
    );
  });
});
