/** Test-only helpers for hand-built issue logs. */
import {
  type Actor,
  compileKind,
  type EventEnvelope,
  eventPath,
  type FoldedLogOf,
  foldLog,
  loadLog,
  MemoryTree,
  type Numbering,
  serializeEvent,
  ulid,
} from "@nikovirtala/ledger";
import { logFixtureFiles, TEST_HUMAN } from "@nikovirtala/ledger/testing";
import { issueKind } from "../kind.js";

export const LAYOUT = issueKind.layoutAt("docs/issues");
export const COMPILED = compileKind(issueKind);

let clock = Date.parse("2026-10-20T09:00:00Z");
function nextAt(): string {
  clock += 60_000;
  return new Date(clock).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** An issue event at `at` (default an increasing clock in 2026) with a fresh ULID. */
export function issueEvent(
  subject: string,
  type: string,
  o: {
    readonly data?: Record<string, unknown>;
    readonly reason?: string | null;
    readonly actor?: Actor;
    readonly at?: string;
  } = {},
): EventEnvelope {
  return {
    envelope: "ledger/v1",
    kind: issueKind.name,
    schema: issueKind.schema,
    id: ulid(),
    subject,
    type,
    at: o.at ?? nextAt(),
    actor: o.actor ?? TEST_HUMAN,
    ...(o.reason === undefined || o.reason === null ? {} : { reason: o.reason }),
    data: o.data ?? {},
  };
}

/** `opened` data with the task template. */
export const openedData = (title: string, parent?: string) => ({
  title,
  template: "task",
  template_version: 1,
  ...(parent === undefined ? {} : { parent }),
});

/**
 * An `opened` event, at a fixed time before every default `at`, so tests can build an issue's
 * later events before its `opened` one.
 */
export const opened = (subject: string, title = `Issue ${subject}`, parent?: string) =>
  issueEvent(subject, "opened", { data: openedData(title, parent), at: OPENED_AT });

/** The `at` of `opened`. */
export const OPENED_AT = "2026-01-01T00:00:00Z";

export interface SubjectSpec {
  readonly id: string;
  /** Body text; `undefined` gives `# <title of the opened event>`, `null` no body file. */
  readonly body?: string | null;
  readonly slug?: string;
  readonly events: readonly EventEnvelope[];
}

/** The files of an issue log under `docs/issues`. */
export function issueFiles(subjects: readonly SubjectSpec[]): Record<string, string> {
  return logFixtureFiles({
    layout: LAYOUT,
    subjects: subjects.map((s) => {
      const title = s.events.find((e) => e.type === "opened")?.data.title;
      const body = s.body === undefined ? `# ${String(title ?? s.id)}\n` : s.body;
      return {
        id: s.id,
        events: [...s.events],
        ...(body === null ? {} : { body, slug: s.slug ?? "" }),
      };
    }),
  });
}

/** The file of one event. */
export const eventFile = (e: EventEnvelope): [string, string] => [
  eventPath(LAYOUT, e),
  serializeEvent(e),
];

/** Folds an issue log held in memory. */
export async function foldFiles(
  files: Readonly<Record<string, string>>,
): Promise<FoldedLogOf<typeof issueKind>> {
  return foldLog(
    issueKind,
    await loadLog(new MemoryTree(files), { kind: COMPILED, layout: LAYOUT }),
  );
}

/** A hand-made available `Numbering` on `refs/heads/main`. */
export function numberingOf(byId: Readonly<Record<string, number>>): Numbering {
  return {
    available: true,
    reason: null,
    ref: "refs/heads/main",
    commit: null,
    byId: new Map(Object.entries(byId)),
    byNumber: new Map(Object.entries(byId).map(([id, n]) => [n, id])),
  };
}

/** Eight-character subject ids that sort in this order: `aaaaaaaa` < `bbbbbbbb` < … */
export const IDS = {
  A: "aaaaaaaa",
  B: "bbbbbbbb",
  C: "cccccccc",
  D: "dddddddd",
  E: "eeeeeeee",
  F: "ffffffff",
  G: "gggggggg",
  X: "xxxxxxxx",
  Z: "zzzzzzzz",
} as const;
