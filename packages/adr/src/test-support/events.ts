/** Test-only helpers for hand-built decision logs. */
import {
  type Actor,
  bodySha256,
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
import { adrKind } from "../kind.js";

export const LAYOUT = adrKind.layoutAt("docs/adr");
export const COMPILED = compileKind(adrKind);
const encoder = new TextEncoder();

export const hashOf = (text: string): string => bodySha256(encoder.encode(text));

/** A decision event at `at` (default an increasing clock in 2026) with a fresh ULID. */
export function decisionEvent(
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
    kind: adrKind.name,
    schema: adrKind.schema,
    id: ulid(),
    subject,
    type,
    at: o.at ?? nextAt(),
    actor: o.actor ?? TEST_HUMAN,
    ...(o.reason === undefined ? {} : { reason: o.reason }),
    data: o.data ?? {},
  };
}

let clock = Date.parse("2026-03-12T09:00:00Z");
function nextAt(): string {
  clock += 60_000;
  return new Date(clock).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface SubjectSpec {
  readonly id: string;
  /** Body text; `undefined` for no body file. */
  readonly body?: string;
  readonly slug?: string;
  readonly events: readonly EventEnvelope[];
}

/** The files of a decision log under `docs/adr`. */
export function decisionFiles(subjects: readonly SubjectSpec[]): Record<string, string> {
  return logFixtureFiles({
    layout: LAYOUT,
    subjects: subjects.map((s) => ({
      id: s.id,
      events: [...s.events],
      ...(s.body === undefined ? {} : { body: s.body, slug: s.slug ?? "" }),
    })),
  });
}

/** The file of one event. */
export const eventFile = (e: EventEnvelope): [string, string] => [
  eventPath(LAYOUT, e),
  serializeEvent(e),
];

/** Folds a decision log held in memory. */
export async function foldFiles(
  files: Readonly<Record<string, string>>,
): Promise<FoldedLogOf<typeof adrKind>> {
  return foldLog(adrKind, await loadLog(new MemoryTree(files), { kind: COMPILED, layout: LAYOUT }));
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

/** `proposed` data with the nygard template. */
export const proposedData = (title: string, supersedes?: readonly string[]) => ({
  title,
  template: "nygard",
  template_version: 1,
  ...(supersedes === undefined ? {} : { supersedes: [...supersedes] }),
});
