import { ConfigError, parseToolConfig } from "@nikovirtala/ledger";
import { describe, expect, it } from "vitest";
import { DEFAULT_ADR_CONFIG, parseAdrConfig } from "./config.js";

const parse = (toml: string) =>
  parseAdrConfig(parseToolConfig(toml, { file: "adr.toml" }), "adr.toml");

describe("parseAdrConfig", () => {
  it("defaults every key", () => {
    expect(parseAdrConfig(null, null)).toEqual({
      defaultTemplate: "nygard",
      mainBranch: null,
      index: "none",
      acceptRequiresHuman: true,
      autoCommit: false,
      mcpCanDecide: false,
      failOn: "error",
    });
    expect(parse("")).toEqual(DEFAULT_ADR_CONFIG);
  });

  it("reads every key", () => {
    expect(
      parse(`
[log]
root = "docs/decisions"
default_template = "madr"
main_branch = "refs/heads/trunk"
index = "committed"

[policy]
accept_requires_human = false
auto_commit = true
mcp_can_decide = true

[verify]
fail_on = "warning"
`),
    ).toEqual({
      defaultTemplate: "madr",
      mainBranch: "refs/heads/trunk",
      index: "committed",
      acceptRequiresHuman: false,
      autoCommit: true,
      mcpCanDecide: true,
      failOn: "warning",
    });
  });

  it("ignores unknown keys and tables", () => {
    expect(parse('[log]\nfuture = 1\n[later]\nx = "y"\n[policy]\nnew_rule = true\n')).toEqual(
      DEFAULT_ADR_CONFIG,
    );
  });

  it.each([
    ["log = 1", "adr.toml: log must be a table"],
    ["policy = []", "adr.toml: policy must be a table"],
    ["verify = 'x'", "adr.toml: verify must be a table"],
    ["[log]\ndefault_template = 3", "log.default_template must be a template name"],
    ["[log]\ndefault_template = 'Nygard'", "log.default_template must be a template name"],
    [
      `[log]\ndefault_template = '${"a".repeat(65)}'`,
      "log.default_template must be a template name",
    ],
    ["[log]\nmain_branch = ''", "log.main_branch must be a ref name"],
    ["[log]\nmain_branch = '--all'", "log.main_branch must be a ref name"],
    ["[log]\nmain_branch = 1", "log.main_branch must be a ref name"],
    ["[log]\nindex = 'git'", 'log.index must be "committed" or "none"'],
    [
      "[policy]\naccept_requires_human = 'yes'",
      "policy.accept_requires_human must be true or false",
    ],
    ["[policy]\nauto_commit = 1", "policy.auto_commit must be true or false"],
    ["[policy]\nmcp_can_decide = 'no'", "policy.mcp_can_decide must be true or false"],
    ["[verify]\nfail_on = 'info'", 'verify.fail_on must be "error" or "warning"'],
  ])("refuses %j", (toml, message) => {
    let error: unknown;
    try {
      parse(toml);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain(message);
    expect((error as ConfigError).file).toBe("adr.toml");
    expect((error as ConfigError).code).toBe("config");
  });

  it("names the file it was given", () => {
    const config = parseToolConfig("[verify]\nfail_on = 1\n", { file: "docs/adr/adr.toml" });
    expect(() => parseAdrConfig(config, "docs/adr/adr.toml")).toThrow(
      /^docs\/adr\/adr\.toml: verify\.fail_on/,
    );
  });
});
