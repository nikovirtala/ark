import { MemoryTree, NO_NUMBERING, type Numbering } from "@nikovirtala/ledger";
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
import { issueUri } from "./resources.js";
import { mcpHeader } from "./text.js";

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
