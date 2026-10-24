import { ConfigError, parseCommitTemplate, parseToolConfig } from "@nikovirtala/ledger";
import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  COMMIT_NAMES,
  COMMIT_VARS,
  INDEX_ACTION,
  INDEX_TITLE,
  LONGEST_ACTION,
} from "./commit-actions.js";
import { DEFAULT_ADR_CONFIG, parseAdrConfig } from "./config.js";
import { adrKind } from "./kind.js";

const DEFAULT_SUBJECT = { source: "docs(adr): {action} {title}", vars: COMMIT_VARS };

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
      governedByInactive: "warning",
      scopeFollowRenames: "stage",
      hookIndex: "check",
      commitSubject: DEFAULT_SUBJECT,
      anchorKeyword: "adr",
      anchorExclude: [],
    });
    expect(adrKind.anchorKeyword).toBe("adr");
    expect(parse("")).toEqual(DEFAULT_ADR_CONFIG);
    expect(parse("[commit]\n")).toEqual(DEFAULT_ADR_CONFIG);
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
governed_by_inactive = "error"

[hooks]
scope_follow_renames = "warn"
index = "stage"

[commit]
subject = "docs({command}): {action} {raw_title} ({display})"

[scope]
anchor_keyword = "decision"
anchor_exclude = ["docs/**", "**/*.test.ts"]
`),
    ).toEqual({
      defaultTemplate: "madr",
      mainBranch: "refs/heads/trunk",
      index: "committed",
      acceptRequiresHuman: false,
      autoCommit: true,
      mcpCanDecide: true,
      failOn: "warning",
      governedByInactive: "error",
      scopeFollowRenames: "warn",
      hookIndex: "stage",
      commitSubject: {
        source: "docs({command}): {action} {raw_title} ({display})",
        vars: COMMIT_VARS,
      },
      anchorKeyword: "decision",
      anchorExclude: ["docs/**", "**/*.test.ts"],
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
    [
      "[verify]\ngoverned_by_inactive = 'info'",
      'verify.governed_by_inactive must be "warning" or "error"',
    ],
    ["hooks = 1", "adr.toml: hooks must be a table"],
    [
      "[hooks]\nscope_follow_renames = true",
      'hooks.scope_follow_renames must be "stage" or "warn" or "off"',
    ],
    ["[hooks]\nindex = 'committed'", 'hooks.index must be "check" or "stage"'],
    ["commit = 'x'", "adr.toml: commit must be a table"],
    ["scope = 1", "adr.toml: scope must be a table"],
    ["[scope]\nanchor_keyword = 'ADR'", "scope.anchor_keyword must match ^[a-z][a-z0-9-]{0,31}$"],
    ["[scope]\nanchor_keyword = 7", "scope.anchor_keyword must match"],
    ["[scope]\nanchor_exclude = 'docs/**'", "scope.anchor_exclude must be an array of at most 100"],
    [
      `[scope]\nanchor_exclude = [${Array(101).fill("'a'").join(",")}]`,
      "scope.anchor_exclude must be an array of at most 100 globs",
    ],
    ["[scope]\nanchor_exclude = [1]", "adr.toml: scope.anchor_exclude[0] must be a string"],
    [
      "[scope]\nanchor_exclude = ['ok/**', '/abs']",
      "adr.toml: scope.anchor_exclude[1]: invalid glob",
    ],
    ["[commit]\nsubject = 1", "adr.toml: commit.subject must be a string"],
    [
      "[commit]\nsubject = 'docs(adr): {verb} {title}'",
      "adr.toml: commit.subject uses unknown placeholder {verb}; use {title}, {raw_title}, {action}, {id}, {display}, {command}",
    ],
    [
      "[commit]\nsubject = 'docs(adr): {title} ({raw_title})'",
      "adr.toml: commit.subject can use {title} or {raw_title} once",
    ],
    [
      "[commit]\nsubject = 'docs(architecture-decisions): {action} {title}'",
      "adr.toml: commit.subject: the type and scope can push the header past 100 characters",
    ],
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

  it("leaves room in [commit] subject for the longest name, which is never shortened", () => {
    // Without {action}, the fixed part is "<x's> "; a cross-log link's name is 42 characters.
    const subject = (fixed: number) =>
      `[commit]\nsubject = 'docs(adr): ${"x".repeat(fixed - 1)} {title}'`;
    const longest = 42;
    expect(() => parse(subject(72 - longest))).not.toThrow();
    expect(() => parse(subject(73 - longest))).toThrow(ConfigError);
    expect(() => parse(subject(73 - longest))).toThrow(
      "adr.toml: commit.subject leaves no room for the title",
    );
  });

  it("leaves a cross-log link's name room up to its boundary", () => {
    // "link" (4) + " " + " " + pad + "ADR-<9 digits> to a decision in another log" (42) ≤ 72.
    const subject = (pad: number) =>
      `[commit]\nsubject = "docs(adr): {action} {title} ${"x".repeat(pad)}"`;
    expect(() => parse(subject(24))).not.toThrow();
    expect(() => parse(subject(25))).toThrow(
      "adr.toml: commit.subject leaves no room for the title",
    );
  });

  it("names the file it was given", () => {
    const config = parseToolConfig("[verify]\nfail_on = 1\n", { file: "docs/adr/adr.toml" });
    expect(() => parseAdrConfig(config, "docs/adr/adr.toml")).toThrow(
      /^docs\/adr\/adr\.toml: verify\.fail_on/,
    );
  });
});

describe("commit name lengths", () => {
  it("derive {action}'s longest value from the action table", () => {
    expect(LONGEST_ACTION).toBe(24);
    expect(LONGEST_ACTION).toBe(ACTIONS.withdrawn.action.length);
    expect(COMMIT_VARS.action).toBe(LONGEST_ACTION);
  });

  it("pair each never-shortened name with its action's length", () => {
    expect(COMMIT_NAMES.map((n) => n.vars.action)).toEqual([
      ACTIONS.superseded.action.length,
      ACTIONS.linked.action.length,
      INDEX_ACTION.length,
    ]);
    expect(COMMIT_NAMES[2]?.length).toBe(INDEX_TITLE.length);
    expect(LONGEST_ACTION).toBeGreaterThanOrEqual(INDEX_ACTION.length);
  });

  it("leave supersede's name room up to its boundary", () => {
    // "supersede" (9) + " " + " " + pad + "ADR-<9 digits> with ADR-<9 digits>" (32) ≤ 72.
    const parseSupersede = (pad: number) =>
      parseCommitTemplate(`docs(adr): {action} {title} ${"x".repeat(pad)}`, {
        vars: { ...COMMIT_VARS, action: ACTIONS.superseded.action.length },
        where: "commit.subject",
        names: COMMIT_NAMES.slice(0, 1),
      });
    expect(() => parseSupersede(29)).not.toThrow();
    expect(() => parseSupersede(30)).toThrow(ConfigError);
    expect(() => parseSupersede(30)).toThrow("commit.subject leaves no room for the title");
  });
});
