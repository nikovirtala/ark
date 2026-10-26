import { type Actor, MemoryTree, NO_NUMBERING } from "@nikovirtala/ledger";
import { describe, expect, it } from "vitest";
import { DEFAULT_ADR_CONFIG } from "../config.js";
import type { DecisionStatus, DecisionView } from "../kind.js";
import { readDecisionsFrom } from "../log.js";
import { decisionEvent, decisionFiles, LAYOUT, proposedData } from "../test-support/events.js";
import {
  DECISION_TOOLS,
  decisionToolsAvailable,
  mcpWriteRefusal,
  type PolicyTool,
  proposalOwner,
} from "./policy.js";

const ME = "niko@example.com";
const AGENT: Actor = {
  kind: "agent",
  name: "kiro",
  email: null,
  agent: "kiro",
  on_behalf_of: "Niko@Example.com",
};

const view = (status: DecisionStatus): DecisionView =>
  ({
    id: "a7c2m9xd",
    number: status === "proposed" ? null : 3,
    display: status === "proposed" ? "a7c2m9xd" : "ADR-0003",
    title: "T",
    status,
    body_path: "docs/adr/decisions/a7c2m9xd-t.md",
  }) as DecisionView;

type Cell = "ok" | "policy" | "library";
type Row = "P-own" | "P-oth" | "A" | "D" | "S" | "R" | "W";
const STATUS: Record<Row, DecisionStatus> = {
  "P-own": "proposed",
  "P-oth": "proposed",
  A: "accepted",
  D: "deprecated",
  S: "superseded",
  R: "rejected",
  W: "withdrawn",
};

// Table B (design §7.5) for the three policy tools: [MCD false, MCD true]. "library" cells are
// writes the state machine or planUpdateDraft refuses (transition/illegal, decision/not-a-draft),
// so the policy leaves them to the library.
const TABLE: Record<PolicyTool, Record<Row, [Cell, Cell]>> = {
  adr_scope: {
    "P-own": ["ok", "ok"],
    "P-oth": ["policy", "ok"],
    A: ["policy", "ok"],
    D: ["policy", "ok"],
    S: ["library", "library"],
    R: ["library", "library"],
    W: ["library", "library"],
  },
  adr_update_draft: {
    "P-own": ["ok", "ok"],
    "P-oth": ["policy", "ok"],
    A: ["library", "library"],
    D: ["library", "library"],
    S: ["library", "library"],
    R: ["library", "library"],
    W: ["library", "library"],
  },
  adr_withdraw: {
    "P-own": ["ok", "ok"],
    "P-oth": ["policy", "ok"],
    A: ["library", "library"],
    D: ["library", "library"],
    S: ["library", "library"],
    R: ["library", "library"],
    W: ["library", "library"],
  },
};

describe("mcpWriteRefusal (Table B)", () => {
  const cells = Object.entries(TABLE).flatMap(([tool, rows]) =>
    Object.entries(rows).flatMap(([row, cells]) =>
      [false, true].map((mcd, i) => [tool, row, mcd, cells[i]] as const),
    ),
  );

  it.each(cells)("%s on %s with mcp_can_decide %s: %s", (tool, row, mcd, cell) => {
    const owner = row === "P-own" ? ME : row === "P-oth" ? "other@example.com" : ME;
    const f = mcpWriteRefusal({
      tool: tool as PolicyTool,
      view: view(STATUS[row as Row]),
      owner,
      actor: AGENT,
      mcpCanDecide: mcd,
      display: (id) => (id === "a7c2m9xd" && row !== "P-own" && row !== "P-oth" ? "ADR-0003" : id),
      eventsDir: "docs/adr/events/a7c2m9xd",
    });
    if (cell === "policy") {
      expect(f).toMatchObject({
        severity: "error",
        rule: "decision/mcp-cannot-decide",
        subject: "a7c2m9xd",
        kind: "decision",
        file: "docs/adr/decisions/a7c2m9xd-t.md",
      });
    } else {
      expect(f).toBeNull();
    }
  });

  it("words the refusals", () => {
    const base = {
      tool: "adr_scope" as const,
      actor: AGENT,
      mcpCanDecide: false,
      display: (id: string) => (id === "a7c2m9xd" ? "ADR-0003" : id),
      eventsDir: "docs/adr/events/a7c2m9xd",
    };
    expect(mcpWriteRefusal({ ...base, view: view("proposed"), owner: null })?.message).toBe(
      "ADR-0003 (a7c2m9xd) was proposed for someone else, and you act for Niko@Example.com; changing another person's proposal needs [policy] mcp_can_decide = true. Add a note with adr_note instead.",
    );
    expect(mcpWriteRefusal({ ...base, view: view("accepted"), owner: ME })?.message).toBe(
      "ADR-0003 (a7c2m9xd) is accepted; rescoping it needs [policy] mcp_can_decide = true, because narrowing a scope can switch a decision off. Ask a human to run adr scope ADR-0003 …, or propose a superseding decision.",
    );
    expect(
      mcpWriteRefusal({
        ...base,
        tool: "adr_withdraw",
        view: view("proposed"),
        owner: "other@example.com",
      })?.message,
    ).toBe(
      "ADR-0003 (a7c2m9xd) was proposed for other@example.com, and you act for Niko@Example.com; withdrawing another person's proposal needs [policy] mcp_can_decide = true. Add a note with adr_note instead.",
    );
  });

  it("uses the events directory without a body", () => {
    const f = mcpWriteRefusal({
      tool: "adr_update_draft",
      view: { ...view("proposed"), body_path: null },
      owner: "other@example.com",
      actor: AGENT,
      mcpCanDecide: false,
      display: (id) => id,
      eventsDir: "docs/adr/events/a7c2m9xd",
    });
    expect(f?.file).toBe("docs/adr/events/a7c2m9xd");
  });
});

describe("proposalOwner", () => {
  const A = "a7c2m9xd";
  const owner = async (actor: Actor) => {
    const files = decisionFiles([
      { id: A, events: [decisionEvent(A, "proposed", { data: proposedData("T"), actor })] },
    ]);
    const read = await readDecisionsFrom(new MemoryTree(files), {
      layout: LAYOUT,
      adr: DEFAULT_ADR_CONFIG,
      numbering: NO_NUMBERING,
    });
    return proposalOwner(read, A);
  };

  it("is the agent's principal or the human's email, lower-cased", async () => {
    expect(await owner(AGENT)).toBe(ME);
    expect(
      await owner({
        kind: "human",
        name: "H",
        email: "Human@Example.com",
        agent: null,
        on_behalf_of: null,
      }),
    ).toBe("human@example.com");
    expect(await owner({ kind: "human", name: "H" })).toBeNull();
  });
});

describe("decisionToolsAvailable", () => {
  it("follows mcp_can_decide", () => {
    expect(decisionToolsAvailable(DEFAULT_ADR_CONFIG)).toBe(false);
    expect(decisionToolsAvailable({ ...DEFAULT_ADR_CONFIG, mcpCanDecide: true })).toBe(true);
    expect(DECISION_TOOLS).toEqual(["adr_accept", "adr_reject", "adr_deprecate", "adr_supersede"]);
  });
});
