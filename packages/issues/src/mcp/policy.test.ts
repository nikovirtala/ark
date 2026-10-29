import { describe, expect, it } from "vitest";
import { DEFAULT_ISSUES_CONFIG, type IssuesConfig } from "../config.js";
import { closeAvailability, REOPEN_REASON } from "./policy.js";
import { toolNames } from "./server.js";

const policy = (mcpCanClose: boolean, closeRequiresHuman: boolean): IssuesConfig => ({
  ...DEFAULT_ISSUES_CONFIG,
  mcpCanClose,
  closeRequiresHuman,
});

const WARNING =
  "issues: warning: issues_close refuses agents while [policy] close_requires_human is true\n";
const reason = (where: string) =>
  `[policy] mcp_can_close is false in ${where}; a person closes issues with the issues CLI, or set it to true and restart issues mcp`;

describe("closeAvailability (design §7.3, Table A)", () => {
  it.each([
    [true, false, { listed: true, warning: null, reason: null }],
    [true, true, { listed: true, warning: WARNING, reason: null }],
    [false, false, { listed: false, warning: null, reason: reason("docs/issues/issues.toml") }],
    [false, true, { listed: false, warning: null, reason: reason("docs/issues/issues.toml") }],
  ])("mcp_can_close %s, close_requires_human %s", (mcc, crh, expected) => {
    expect(closeAvailability(policy(mcc, crh), "docs/issues/issues.toml")).toEqual(expected);
  });

  it("names a missing issues.toml", () => {
    expect(closeAvailability(policy(false, false), null).reason).toBe(
      reason("issues.toml (not present)"),
    );
  });

  it("refers reopening to people", () => {
    expect(REOPEN_REASON).toBe(
      "reopening is left to people (ADR-0014); explain with issues_comment why the issue should be reopened, and tell the user",
    );
  });
});

describe("toolNames", () => {
  it("lists issues_close only when mcp_can_close is true", () => {
    const all = toolNames(DEFAULT_ISSUES_CONFIG);
    expect(all).toHaveLength(17);
    expect(all).toContain("issues_close");
    expect(toolNames(policy(true, true))).toEqual(all);
    const without = toolNames(policy(false, false));
    expect(without).toEqual(all.filter((t) => t !== "issues_close"));
    expect(without).toHaveLength(16);
    expect(all).not.toContain("issues_reopen");
  });
});
