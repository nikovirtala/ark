import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_ISSUES_CONFIG } from "./config.js";
import { issueEvents } from "./kind/schemas.js";
import { issueKind } from "./kind.js";
import { issuesPrompts } from "./mcp/prompts.js";
import { toolNames } from "./mcp/server.js";

// docs/02-issues-v1.md describes the kind and the MCP surface; these checks keep its event table,
// states, tools and prompts in step with the code (scripts/test-inputs.txt lists the file, so editing it runs this test).
const DOC = readFileSync(new URL("../../../docs/02-issues-v1.md", import.meta.url), "utf8");

/** The lines of the section under `heading`, up to the next `## ` heading. */
function section(heading: string): string[] {
  const lines = DOC.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`02 has no ${heading} section`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? lines.length : end);
}

describe("docs/02-issues-v1.md", () => {
  it("lists the kind's event types, in order, in the Event schema table", () => {
    const lines = section("## Event schema");
    const first = lines.findIndex((l) => l.startsWith("| "));
    expect(first).toBeGreaterThanOrEqual(0);
    const table = lines
      .slice(first)
      .filter((_, i, all) => all.slice(0, i + 1).every((l) => l.startsWith("|")));
    const names = table.flatMap((l) => {
      const m = /^\| `([a-z-]+)` \|/.exec(l);
      return m === null ? [] : [m[1]];
    });
    expect(names).toEqual(Object.keys(issueEvents));
  });

  it("names the kind's states under State machine and invariants", () => {
    const sentence = section("## State machine and invariants")
      .join("\n")
      .match(/The states are ((?:`[a-z-]+`(?:, | and )?)+)\./);
    expect(sentence).not.toBeNull();
    const states = [...(sentence?.[1] ?? "").matchAll(/`([a-z-]+)`/g)].map((m) => m[1]);
    expect(states).toEqual([...issueKind.def.states]);
  });

  it("lists issues mcp's tools, in order, in the MCP surface table", () => {
    const lines = section("## MCP surface");
    const start = lines.indexOf("**Tools**");
    expect(start).toBeGreaterThanOrEqual(0);
    const first = lines.findIndex((l, i) => i > start && l.startsWith("| "));
    const table = lines
      .slice(first)
      .filter((_, i, all) => all.slice(0, i + 1).every((l) => l.startsWith("|")));
    // A cell such as `issues_start`, `issues_stop` names two tools.
    const names = table.flatMap((l) => {
      const cell = l.split("|")[1] ?? "";
      return [...cell.matchAll(/`(issues_[a-z_]+)`/g)].map((m) => m[1]);
    });
    expect(names).toEqual(toolNames(DEFAULT_ISSUES_CONFIG));
  });

  it("names issues mcp's prompts on the Prompts line", () => {
    const line = section("## MCP surface").find((l) => l.startsWith("**Prompts:**")) ?? "";
    const names = [...line.matchAll(/`(issues_[a-z_]+)`/g)].map((m) => m[1]);
    expect(names).toEqual(issuesPrompts({ cwd: "", root: null, env: {} }).map((p) => p.name));
  });
});
