import { describe, expect, it } from "vitest";
import { compileKind, type KindSchema } from "../envelope/kind.js";
import { serializeEvent } from "../envelope/yaml.js";
import { formatGithub, formatJson, formatText } from "../findings/format.js";
import { MemoryTree } from "../git/tree.js";
import { bodySha256 } from "../identity/hash.js";
import { normalizeLayout } from "../identity/layout.js";
import { verifySnapshots } from "./verify.js";

// The fixture of design §9: a decision log at docs/adr with one accepted event modified, a
// frozen body edited, an agent event without actor.agent, an event from a newer envelope
// version, and a stray file. The __samples__ files are the real formatter output for it.

const open = { data: { type: "object" } } as const;
const decision: KindSchema = {
  name: "decision",
  schemas: {
    "decision/v1": {
      events: {
        proposed: open,
        accepted: { data: { type: "object", properties: { body_sha256: { type: "string" } } } },
        noted: open,
      },
    },
  },
  body: { freezeOn: "accepted" },
};
const layout = normalizeLayout({ root: "docs/adr", bodies: "decisions" });
const hash = (text: string) => bodySha256(new TextEncoder().encode(text));

const ADR = "a7c2m9xd";
const OTHER = "k3f9q8a1";
const BODY_PATH = `docs/adr/decisions/${ADR}-use-dynamodb-for-orders.md`;
const BODY = "# Use DynamoDB for orders\n\n## Context\n\nOrders need single-digit latency.\n";
const EDITED = `${BODY}\nEdited after acceptance.\n`;
const events = `docs/adr/events`;
const human = { kind: "human", name: "Ada Lovelace", email: "ada@example.com" };
const envelope = (o: Record<string, unknown>) => ({
  envelope: "ledger/v1",
  kind: "decision",
  schema: "decision/v1",
  actor: human,
  ...o,
});
const proposed = envelope({
  id: "01JAA1B2C3D4E5F6G7H8J9K0P1",
  subject: ADR,
  type: "proposed",
  at: "2026-03-10T09:00:00Z",
  data: { title: "Use DynamoDB for orders" },
});
const accepted = (bodyHash: string) =>
  envelope({
    id: "01JAB3K9Z6Q8M2X7FQ0V4TQ8A1",
    subject: ADR,
    type: "accepted",
    at: "2026-03-14T12:02:11Z",
    data: { body_sha256: bodyHash },
  });

const base = {
  [`${events}/${ADR}/20260310T090000Z-k0p1-proposed.yaml`]: serializeEvent(proposed),
  [`${events}/${ADR}/20260314T120211Z-q8a1-accepted.yaml`]: serializeEvent(accepted(hash(BODY))),
  [BODY_PATH]: BODY,
};
const head = {
  ...base,
  // The body was edited and the recorded hash updated to match, so only the base comparison
  // and the append-only rule catch it.
  [`${events}/${ADR}/20260314T120211Z-q8a1-accepted.yaml`]: serializeEvent(accepted(hash(EDITED))),
  [BODY_PATH]: EDITED,
  [`${events}/${OTHER}/.gitkeep`]: "",
  // Hand-edited: serializeEvent would write `agent: null`.
  [`${events}/${OTHER}/20261016T081030Z-p4d2-proposed.yaml`]: serializeEvent(
    envelope({
      id: "01JAD7Q2M8K4X9ZT3V5WR6P4D2",
      subject: OTHER,
      type: "proposed",
      at: "2026-10-16T08:10:30Z",
      actor: { kind: "agent", name: "Release bot" },
      data: { title: "Adopt event sourcing for billing" },
    }),
  ).replace("  agent: null\n", ""),
  [`${events}/${OTHER}/20261018T070215Z-z9c4-noted.yaml`]: serializeEvent(
    envelope({
      envelope: "ledger/v2",
      id: "01JAF2B7N4K8X3ZT6V9WQ5Z9C4",
      subject: OTHER,
      type: "noted",
      at: "2026-10-18T07:02:15Z",
      data: {},
    }),
  ),
};

// Design §9, verbatim.
const SECTION_9_TEXT = `docs/adr/decisions/a7c2m9xd-use-dynamodb-for-orders.md: error: body changed after it was frozen by accepted event 01JAB3K9Z6Q8M2X7FQ0V4TQ8A1 [body/frozen-modified] (a7c2m9xd)
docs/adr/events/a7c2m9xd/20260314T120211Z-q8a1-accepted.yaml: error: event file was modified; event files are append-only [append-only/modified] (a7c2m9xd)
docs/adr/events/k3f9q8a1/.gitkeep: warning: unexpected file in an event directory [identity/stray-file] (k3f9q8a1)
docs/adr/events/k3f9q8a1/20261016T081030Z-p4d2-proposed.yaml: error: /actor: must have required property 'agent' [envelope/schema] (k3f9q8a1)
docs/adr/events/k3f9q8a1/20261018T070215Z-z9c4-noted.yaml: error: unknown envelope version "ledger/v2"; upgrade the tool to read this event [envelope/unknown-version] (k3f9q8a1)

4 errors, 1 warning`;

const SECTION_9_GITHUB = `::error file=docs/adr/decisions/a7c2m9xd-use-dynamodb-for-orders.md,title=body/frozen-modified::body changed after it was frozen by accepted event 01JAB3K9Z6Q8M2X7FQ0V4TQ8A1 (a7c2m9xd)
::error file=docs/adr/events/a7c2m9xd/20260314T120211Z-q8a1-accepted.yaml,title=append-only/modified::event file was modified; event files are append-only (a7c2m9xd)
::warning file=docs/adr/events/k3f9q8a1/.gitkeep,title=identity/stray-file::unexpected file in an event directory (k3f9q8a1)
::error file=docs/adr/events/k3f9q8a1/20261016T081030Z-p4d2-proposed.yaml,title=envelope/schema::/actor: must have required property 'agent' (k3f9q8a1)
::error file=docs/adr/events/k3f9q8a1/20261018T070215Z-z9c4-noted.yaml,title=envelope/unknown-version::unknown envelope version "ledger/v2"; upgrade the tool to read this event (k3f9q8a1)`;

describe("§9 sample output", () => {
  it("is what the real pipeline and formatters produce", async () => {
    const findings = await verifySnapshots({
      kind: compileKind(decision),
      layout,
      base: new MemoryTree(base),
      head: new MemoryTree(head),
      scope: "all",
    });
    const text = formatText(findings);
    const json = formatJson(findings);
    const github = formatGithub(findings);
    await expect(text).toMatchFileSnapshot("./__samples__/findings.text.txt");
    await expect(json).toMatchFileSnapshot("./__samples__/findings.json.txt");
    await expect(github).toMatchFileSnapshot("./__samples__/findings.github.txt");

    expect(text).toBe(SECTION_9_TEXT);
    expect(github).toBe(SECTION_9_GITHUB);
    const report = JSON.parse(json);
    expect(report).toMatchObject({
      format: "ledger-findings/v1",
      ok: false,
      summary: { errors: 4, warnings: 1 },
    });
    expect(report.findings).toHaveLength(5);
    expect(report.findings.slice(0, 2)).toEqual([
      {
        severity: "error",
        rule: "body/frozen-modified",
        message: "body changed after it was frozen by accepted event 01JAB3K9Z6Q8M2X7FQ0V4TQ8A1",
        file: "docs/adr/decisions/a7c2m9xd-use-dynamodb-for-orders.md",
        line: null,
        subject: "a7c2m9xd",
        kind: "decision",
      },
      {
        severity: "error",
        rule: "append-only/modified",
        message: "event file was modified; event files are append-only",
        file: "docs/adr/events/a7c2m9xd/20260314T120211Z-q8a1-accepted.yaml",
        line: null,
        subject: "a7c2m9xd",
        kind: "decision",
      },
    ]);
  });
});
