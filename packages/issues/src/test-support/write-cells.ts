/**
 * Design §7.3's Table B as data: what each write tool does to an issue in each state, run the
 * same way over the in-memory client (`mcp/write-tools.test.ts`) and the built server over stdio
 * (`mcp-e2e.table-b.test.ts`, session W7).
 */
import { expect } from "vitest";
import type { WriteIssues } from "./mcp.js";

/** Open, open and blocked, in progress, closed done, closed wontfix, closed duplicate; open with an open child. */
export type IssueState = "O" | "OB" | "P" | "Cd" | "Cx" | "Cdup" | "Och";

/**
 * The order cells run in: the closed ones first, then the blocked issue before the issue it
 * waits for, so closing or stopping that one can't unblock it first.
 */
export const STATE_ORDER: readonly IssueState[] = ["Cd", "Cx", "Cdup", "OB", "P", "O", "Och"];

/** The issue of `writeRepo` in each state. */
export function issueIn(s: IssueState, ids: WriteIssues): string {
  return { O: ids.e, OB: ids.c, P: ids.a, Cd: ids.d, Cx: ids.f, Cdup: ids.b, Och: ids.g }[s];
}

/**
 * One cell: `ok: true` with the findings it must carry (`rules`, contained; `exact`, equal) and
 * texts its notes contain (`notes`); or a refusal whose rules equal `exact` or contain
 * `contains`, and whose messages contain `messages`.
 */
export type Cell =
  | {
      readonly ok: true;
      readonly rules?: readonly string[];
      readonly exact?: readonly string[];
      readonly notes?: readonly string[];
    }
  | {
      readonly ok: false;
      readonly exact?: readonly string[];
      readonly contains?: readonly string[];
      /** Texts the refusal's messages contain, given the repository's issues. */
      readonly messages?: (ids: WriteIssues) => readonly string[];
    };

export const ILLEGAL: Cell = { ok: false, exact: ["transition/illegal"] };
export const OK: Cell = { ok: true };

/** Where a row runs: the repository its writes leave fit for the rows after it. */
export type RowRepo = "shared" | "start" | "stop" | "close" | "crh";

export interface TableBRow {
  readonly row: string;
  readonly tool: string;
  readonly repo: RowRepo;
  /** `[policy]` keys to write to `issues.toml` (uncommitted) before the row, while the server runs. */
  readonly policy?: string;
  /** Tool calls that set the row up, run before its cells; each must succeed. */
  readonly before?: (ids: WriteIssues) => readonly (readonly [string, Record<string, unknown>])[];
  readonly args: (id: string, ids: WriteIssues, s: IssueState) => Record<string, unknown>;
  readonly cells: Readonly<Partial<Record<IssueState, Cell>>>;
}

const REASON = "Every Done when condition is met: checked by the test.";
const closed = { Cd: ILLEGAL, Cx: ILLEGAL, Cdup: ILLEGAL } as const;
/** A close the policy refuses, with no reason: the policy's rule and the reason rule. */
const policyWithoutReason = Object.fromEntries(
  (["O", "OB", "P"] as const).map((s) => [
    s,
    { ok: false, contains: ["issue/agent-closed", "issue/agent-reason-required"] } as Cell,
  ]),
);
const every = (c: Cell) => ({ O: c, OB: c, P: c, Cd: c, Cx: c, Cdup: c });
const LINT: Cell = { ok: true, rules: ["template/section-empty"] };
/** A scope glob of the O issue that matches no tracked file, for the issues_start row. */
const UNMATCHED = "src/billing/**";

export const TABLE_B: readonly TableBRow[] = [
  {
    row: "issues_update",
    tool: "issues_update",
    repo: "shared",
    args: (id) => ({ id, sections: { done: "" } }),
    // Closed issues aren't linted.
    cells: {
      O: LINT,
      OB: LINT,
      P: LINT,
      Cd: { ok: true, exact: [] },
      Cx: { ok: true, exact: [] },
      Cdup: { ok: true, exact: [] },
    },
  },
  {
    row: "issues_comment",
    tool: "issues_comment",
    repo: "shared",
    args: (id) => ({ id, text: "Checked by the test." }),
    cells: every(OK),
  },
  {
    row: "issues_link",
    tool: "issues_link",
    repo: "shared",
    args: (id, ids) => ({ id, to: ids.h, rel: "relates-to" }),
    cells: every(OK),
  },
  {
    row: "issues_unlink",
    tool: "issues_unlink",
    repo: "shared",
    args: (id, ids) => ({ id, to: ids.h, rel: "relates-to" }),
    cells: every(OK),
  },
  {
    row: "issues_label",
    tool: "issues_label",
    repo: "shared",
    args: (id) => ({ id, add: ["area:auth"] }),
    cells: every(OK),
  },
  {
    row: "issues_assign",
    tool: "issues_assign",
    repo: "shared",
    args: (id) => ({ id, add: ["me"] }),
    cells: every(OK),
  },
  {
    row: "issues_scope",
    tool: "issues_scope",
    repo: "shared",
    args: (id) => ({ id, add: ["README.md"] }),
    cells: every(OK),
  },
  {
    row: "issues_start",
    tool: "issues_start",
    repo: "start",
    before: (ids) => [["issues_scope", { id: ids.e, add: [UNMATCHED] }]],
    args: (id) => ({ id }),
    cells: {
      ...closed,
      OB: { ok: true, rules: ["issue/started-blocked"] },
      P: ILLEGAL,
      O: { ok: true, notes: [`${UNMATCHED} matches no tracked file`] },
    },
  },
  {
    row: "issues_stop",
    tool: "issues_stop",
    repo: "stop",
    args: (id) => ({ id, reason: "the rest waits for review" }),
    cells: { ...closed, OB: ILLEGAL, P: OK, O: ILLEGAL },
  },
  {
    row: "issues_close, allowed, with reason",
    tool: "issues_close",
    repo: "close",
    args: (id) => ({ id, reason: REASON }),
    cells: {
      ...closed,
      OB: { ok: true, rules: ["issue/closed-with-open-dependencies"] },
      P: OK,
      O: OK,
      Och: { ok: true, rules: ["issue/closed-with-open-children"] },
    },
  },
  {
    row: "issues_close, no reason",
    tool: "issues_close",
    repo: "shared",
    args: (id) => ({ id }),
    cells: {
      ...closed,
      ...Object.fromEntries(
        (["O", "OB", "P"] as const).map((s) => [
          s,
          { ok: false, contains: ["issue/agent-reason-required"] },
        ]),
      ),
    },
  },
  {
    row: "issues_close wontfix, no reason",
    tool: "issues_close",
    repo: "shared",
    args: (id) => ({ id, resolution: "wontfix" }),
    cells: {
      ...closed,
      ...Object.fromEntries(
        (["O", "OB", "P"] as const).map((s) => [
          s,
          { ok: false, contains: ["issue/agent-reason-required", "issue/reason-required"] },
        ]),
      ),
    },
  },
  {
    row: "issues_close as a duplicate of a duplicate",
    tool: "issues_close",
    repo: "shared",
    // b is a duplicate of a: the refusal names a, the issue to close against. b itself, closed,
    // is closed against e (against itself would be a usage error).
    args: (id, ids, s) => ({
      id,
      resolution: "duplicate",
      of: s === "Cdup" ? ids.e : ids.b,
      reason: REASON,
    }),
    cells: {
      ...closed,
      ...Object.fromEntries(
        (["O", "OB", "P"] as const).map((s) => [
          s,
          {
            ok: false,
            contains: ["issue/duplicate-of-duplicate"],
            messages: (ids: WriteIssues) => [`as a duplicate of ${ids.a}`],
          },
        ]),
      ),
    },
  },
  {
    row: "issues_close forming a cycle",
    tool: "issues_close",
    repo: "shared",
    // c depends on a, and i on c and e: closing a dependency as a duplicate of the issue that
    // depends on it folds the dependency onto that issue.
    args: (id, ids, s) => ({
      id,
      resolution: "duplicate",
      of: s === "P" ? ids.c : s === "O" || s === "OB" ? ids.i : ids.e,
      reason: REASON,
    }),
    cells: {
      ...closed,
      O: { ok: false, contains: ["issue/cycle"] },
      OB: { ok: false, contains: ["issue/cycle"] },
      P: { ok: false, contains: ["issue/cycle"] },
    },
  },
  {
    row: "issues_close while close_requires_human is true",
    tool: "issues_close",
    repo: "crh",
    args: (id) => ({ id, reason: REASON }),
    cells: {
      ...closed,
      ...Object.fromEntries(
        (["O", "OB", "P"] as const).map((s) => [
          s,
          { ok: false, contains: ["issue/agent-closed"] },
        ]),
      ),
    },
  },
  {
    row: "issues_close without a reason while close_requires_human is true",
    tool: "issues_close",
    repo: "crh",
    args: (id) => ({ id }),
    cells: { ...closed, ...policyWithoutReason },
  },
  {
    row: "issues_close after mcp_can_close turned false",
    tool: "issues_close",
    repo: "shared",
    policy: "[policy]\nmcp_can_close = false\n",
    args: (id) => ({ id, reason: REASON }),
    cells: {
      ...closed,
      ...Object.fromEntries(
        (["O", "OB", "P"] as const).map((s) => [
          s,
          { ok: false, contains: ["issue/agent-closed"] },
        ]),
      ),
    },
  },
  {
    row: "issues_close without a reason after mcp_can_close turned false",
    tool: "issues_close",
    repo: "shared",
    policy: "[policy]\nmcp_can_close = false\n",
    args: (id) => ({ id }),
    cells: { ...closed, ...policyWithoutReason },
  },
];

type Result = {
  readonly isError?: unknown;
  readonly structuredContent?: unknown;
  readonly content?: unknown;
};

/**
 * Runs `rows` through `call`, cell by cell in `STATE_ORDER`, asserting each cell. `setPolicy`
 * writes a row's `policy` to `issues.toml` before it runs.
 */
export async function runTableB(
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  ids: WriteIssues,
  rows: readonly TableBRow[],
  o: { readonly setPolicy?: (toml: string) => Promise<void> } = {},
): Promise<number> {
  let n = 0;
  for (const row of rows) {
    if (row.policy !== undefined) {
      if (o.setPolicy === undefined) throw new Error(`${row.row} needs setPolicy`);
      await o.setPolicy(row.policy);
    }
    for (const [tool, args] of row.before?.(ids) ?? []) {
      const res = (await call(tool, args)) as Result;
      expect(res.isError, `${row.row}: ${tool}`).toBeUndefined();
      expect((res.structuredContent as { ok: boolean }).ok, `${row.row}: ${tool}`).toBe(true);
    }
    for (const s of STATE_ORDER) {
      const cell = row.cells[s];
      if (cell === undefined) continue;
      const where = `${row.row} × ${s}`;
      const res = (await call(row.tool, row.args(issueIn(s, ids), ids, s))) as Result;
      expect(res.isError, `${where}: ${JSON.stringify(res.content)}`).toBeUndefined();
      const d = res.structuredContent as {
        ok: boolean;
        written: string[];
        findings: { rule: string; message: string }[];
      };
      const rules = d.findings.map((f) => f.rule);
      expect(d.ok, `${where}: ${rules.join(", ")}`).toBe(cell.ok);
      if (cell.ok) {
        for (const r of cell.rules ?? []) expect(rules, where).toContain(r);
        if (cell.exact !== undefined) expect(rules, where).toEqual(cell.exact);
        const notes = (d as { notes?: string[] }).notes ?? [];
        for (const t of cell.notes ?? []) {
          expect(
            notes.some((n) => n.includes(t)),
            `${where}: ${notes.join("; ")}`,
          ).toBe(true);
        }
        expect(d.written.length, where).toBeGreaterThan(0);
      } else {
        if (cell.exact !== undefined) expect(rules, where).toEqual(cell.exact);
        for (const r of cell.contains ?? []) expect(rules, where).toContain(r);
        const messages = d.findings.map((f) => f.message).join("\n");
        for (const m of cell.messages?.(ids) ?? []) expect(messages, where).toContain(m);
      }
      n++;
    }
  }
  return n;
}
