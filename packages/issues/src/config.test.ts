import { ConfigError, parseToolConfig, renderCommitMessage } from "@nikovirtala/ledger";
import { describe, expect, it } from "vitest";
import { COMMIT_VARS } from "./commit-actions.js";
import { DEFAULT_ISSUES_CONFIG, INDEX_UNSUPPORTED, parseIssuesConfig } from "./config.js";

const FILE = "docs/issues/issues.toml";
const parse = (toml: string) => parseIssuesConfig(parseToolConfig(toml, { file: FILE }), FILE);
const fails = (toml: string): string => {
  try {
    parse(toml);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error(`expected a ConfigError for ${toml}`);
};

describe("parseIssuesConfig", () => {
  it("returns the defaults without a config, or with an empty one", () => {
    expect(parseIssuesConfig(null, null)).toBe(DEFAULT_ISSUES_CONFIG);
    expect(parse("")).toEqual(DEFAULT_ISSUES_CONFIG);
    expect(DEFAULT_ISSUES_CONFIG).toMatchObject({
      defaultTemplate: "task",
      mainBranch: null,
      index: "none",
      exclusive: [],
      priority: [],
      closeRequiresHuman: false,
      mcpCanClose: true,
      autoCommit: false,
      failOn: "error",
      anchorKeyword: "issue",
      anchorExclude: [],
    });
    expect(DEFAULT_ISSUES_CONFIG.commitSubject.source).toBe("docs(issues): {action} {title}");
  });

  it("reads every key", () => {
    const c = parse(`
[log]
default_template = "bug"
main_branch = "trunk"
index = "none"
[labels]
exclusive = ["priority", "type"]
priority = ["priority:high", "priority:low"]
[policy]
close_requires_human = true
mcp_can_close = false
auto_commit = true
[verify]
fail_on = "warning"
[commit]
subject = "chore(issues): {action} {title}"
[scope]
anchor_keyword = "ticket"
anchor_exclude = ["docs/**"]
`);
    expect(c).toMatchObject({
      defaultTemplate: "bug",
      mainBranch: "trunk",
      index: "none",
      exclusive: ["priority", "type"],
      priority: ["priority:high", "priority:low"],
      closeRequiresHuman: true,
      mcpCanClose: false,
      autoCommit: true,
      failOn: "warning",
      anchorKeyword: "ticket",
      anchorExclude: ["docs/**"],
    });
    expect(c.commitSubject.source).toBe("chore(issues): {action} {title}");
  });

  it("ignores unknown keys and tables, [hooks] included", () => {
    expect(parse('[log]\nfuture = 1\n[hooks]\nindex = "stage"\n[other]\nx = 1\n')).toEqual(
      DEFAULT_ISSUES_CONFIG,
    );
  });

  it('refuses index = "committed", which this version can\'t keep fresh', () => {
    expect(fails('[log]\nindex = "committed"\n')).toBe(`${FILE}: ${INDEX_UNSUPPORTED}`);
    expect(fails('[log]\nindex = "comitted"\n')).toBe(
      `${FILE}: log.index must be "none" or "committed"`,
    );
  });

  it("names the file and key of every wrong value", () => {
    const cases: [string, string][] = [
      ["log = 1", "log must be a table"],
      ['[log]\ndefault_template = "Bug"', "log.default_template must be a template name"],
      ['[log]\nmain_branch = "-x"', "log.main_branch must be a ref name"],
      ['[log]\nmain_branch = " "', "log.main_branch must be a ref name"],
      ["[labels]\nexclusive = 1", "labels.exclusive must be an array of at most 50 prefixes"],
      ['[labels]\nexclusive = ["a:b"]', "labels.exclusive[0] must be a prefix"],
      ['[labels]\nexclusive = ["a", "a"]', 'labels.exclusive[1] "a" is listed twice'],
      [
        `[labels]\nexclusive = [${Array.from({ length: 51 }, (_, i) => `"p${i}"`).join(", ")}]`,
        "at most 50",
      ],
      ['[labels]\npriority = ["a b"]', "labels.priority[0] must be a label"],
      ['[labels]\npriority = ["p:1", "p:1"]', 'labels.priority[1] "p:1" is listed twice'],
      [
        '[policy]\nclose_requires_human = "yes"',
        "policy.close_requires_human must be true or false",
      ],
      ["[policy]\nmcp_can_close = 1", "policy.mcp_can_close must be true or false"],
      ["[policy]\nauto_commit = 0", "policy.auto_commit must be true or false"],
      ['[verify]\nfail_on = "never"', 'verify.fail_on must be "error" or "warning"'],
      ['[commit]\nsubject = "docs: {nope}"', "commit.subject uses unknown placeholder {nope}"],
      ['[scope]\nanchor_keyword = "Issue"', "scope.anchor_keyword must match"],
      ['[scope]\nanchor_exclude = ["["]', "scope.anchor_exclude[0]:"],
    ];
    for (const [toml, message] of cases) {
      const got = fails(toml);
      expect(got.startsWith(`${FILE}: `), toml).toBe(true);
      expect(got, toml).toContain(message);
    }
  });

  it("checks the kinds and names of [[sources]]", () => {
    const source = (name: string, kind: string) =>
      `[[sources]]\nname = "${name}"\nkind = "${kind}"\nurl = "https://example.com/r.git"\nref = "main"\n`;
    expect(parse(source("platform", "issues")).defaultTemplate).toBe("task");
    expect(parse(source("platform-adr", "adr")).defaultTemplate).toBe("task");
    expect(fails(source("platform", "jira"))).toBe(
      `${FILE}: sources[0].kind must be "issues" or "adr"`,
    );
    expect(fails(source("adr", "adr"))).toBe(
      `${FILE}: sources[0]: source name adr is reserved for this repository's decision log`,
    );
  });

  it("fits the longest names in the default subject without shortening them", () => {
    const longest = [
      ["close", `?123456789 as a duplicate of ?123456788`],
      ["unlink", "?123456789 to a decision in another log"],
      ["set up", "the issue log"],
    ];
    for (const [action, title] of longest) {
      const r = renderCommitMessage(DEFAULT_ISSUES_CONFIG.commitSubject, {
        title: title ?? "",
        vars: { action: action ?? "", id: "m4p8x2kd", display: "?1", command: "close" },
      });
      expect(r.shortened).toBe(false);
      expect(r.subject).toBe(`docs(issues): ${action} ${title}`);
    }
    expect(COMMIT_VARS.action).toBe("edit the description of".length);
  });
});
