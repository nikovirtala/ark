import { describe, expect, it } from "vitest";
import { ConfigError } from "../errors.js";
import { parseToolConfig, type ToolConfig } from "../sources/config.js";
import {
  parseNumberingKeys,
  parseSharedKeys,
  type SharedKeyOptions,
  toolConfigReader,
} from "./tool-log.js";

const config = (toml: string, file?: string): ToolConfig =>
  parseToolConfig(toml, file === undefined ? {} : { file });
const reader = (toml: string, file: string | null = "widget.toml") =>
  toolConfigReader(config(toml), file, "widget");

const OPTIONS: SharedKeyOptions = {
  defaults: {
    defaultTemplate: "plain",
    anchorKeyword: "widget",
    commit: { vars: { action: 10 }, defaultSubject: "docs(widget): {action} {title}" },
  },
  indexValues: ["committed", "none"],
};
const shared = (toml: string, o: SharedKeyOptions = OPTIONS) => parseSharedKeys(reader(toml), o);

describe("toolConfigReader", () => {
  it("names the given file, else the config's, else <tool>.toml", () => {
    expect(toolConfigReader(config("", "a/widget.toml"), "widget.toml", "widget").where).toBe(
      "widget.toml",
    );
    expect(toolConfigReader(config("", "a/widget.toml"), null, "widget").where).toBe(
      "a/widget.toml",
    );
    const r = toolConfigReader(config(""), null, "widget");
    expect(r.where).toBe("widget.toml");
    const e = r.fail("x is wrong");
    expect(e).toBeInstanceOf(ConfigError);
    expect(e.message).toBe("widget.toml: x is wrong");
    expect(e.file).toBe("widget.toml");
  });

  it("returns the config it reads", () => {
    const c = config("");
    expect(toolConfigReader(c, null, "widget").config).toBe(c);
  });

  it("reads tables, refusing anything else", () => {
    const r = reader('[log]\nroot = "x"\n');
    expect(r.table("log")).toEqual({ root: "x" });
    expect(r.table("missing")).toEqual({});
    expect(() => reader("log = 1\n").table("log")).toThrow("widget.toml: log must be a table");
    expect(() => reader("log = [1]\n").table("log")).toThrow("widget.toml: log must be a table");
    expect(() => reader("log = 2026-10-31\n").table("log")).toThrow(
      "widget.toml: log must be a table",
    );
  });

  it("reads booleans", () => {
    const r = reader("");
    expect(r.bool({}, "policy", "x", true)).toBe(true);
    expect(r.bool({ x: false }, "policy", "x", true)).toBe(false);
    expect(() => r.bool({ x: "yes" }, "policy", "x", true)).toThrow(
      "widget.toml: policy.x must be true or false",
    );
  });

  it("reads one of a list of strings, naming them in order", () => {
    const r = reader("");
    const values = ["b", "a"] as const;
    expect(r.oneOf({}, "s", "k", values, "a")).toBe("a");
    expect(r.oneOf({ k: "b" }, "s", "k", values, "a")).toBe("b");
    for (const v of ["c", 1, true]) {
      expect(() => r.oneOf({ k: v }, "s", "k", values, "a")).toThrow(
        'widget.toml: s.k must be "b" or "a"',
      );
    }
  });
});

describe("parseNumberingKeys", () => {
  const fail = toolConfigReader(config(""), "adr.toml", "adr").fail;
  const parse = (log: Record<string, unknown>, indexValues = OPTIONS.indexValues) =>
    parseNumberingKeys(log, fail, { indexValues });

  it("defaults to no main branch and no index", () => {
    expect(parse({})).toEqual({ mainBranch: null, index: "none" });
  });

  it("reads main_branch and index, ignoring other keys", () => {
    expect(
      parse({ main_branch: "trunk", index: "committed", root: 1, default_template: 2 }),
    ).toEqual({ mainBranch: "trunk", index: "committed" });
    expect(parse({ index: "none" }).index).toBe("none");
  });

  it.each(["", " ", "-x", "a\0b", 1])("refuses main_branch %j", (v) => {
    expect(() => parse({ main_branch: v })).toThrow(
      "adr.toml: log.main_branch must be a ref name that doesn't start with -",
    );
  });

  it("refuses an unknown index, listing the values in indexValues order", () => {
    for (const v of ["always", 1]) {
      expect(() => parse({ index: v })).toThrow(
        'adr.toml: log.index must be "committed" or "none"',
      );
      expect(() => parse({ index: v }, ["none", "committed"])).toThrow(
        'adr.toml: log.index must be "none" or "committed"',
      );
    }
  });
});

describe("parseSharedKeys", () => {
  it("gives the defaults for an empty config", () => {
    const keys = shared("");
    expect({ ...keys, commitSubject: keys.commitSubject.source }).toEqual({
      defaultTemplate: "plain",
      mainBranch: null,
      index: "none",
      autoCommit: false,
      failOn: "error",
      anchorKeyword: "widget",
      anchorExclude: [],
      scopeFollowRenames: "stage",
      hookIndex: "check",
      commitSubject: "docs(widget): {action} {title}",
    });
  });

  it("reads every key", () => {
    const keys = shared(
      [
        "[log]",
        'default_template = "madr-2"',
        'main_branch = "trunk"',
        'index = "committed"',
        "[policy]",
        "auto_commit = true",
        "[verify]",
        'fail_on = "warning"',
        "[scope]",
        'anchor_keyword = "dec"',
        'anchor_exclude = ["docs/**", "*.md"]',
        "[hooks]",
        'scope_follow_renames = "warn"',
        'index = "stage"',
        "[commit]",
        'subject = "chore: {action} {title}"',
        "",
      ].join("\n"),
    );
    expect({ ...keys, commitSubject: keys.commitSubject.source }).toEqual({
      defaultTemplate: "madr-2",
      mainBranch: "trunk",
      index: "committed",
      autoCommit: true,
      failOn: "warning",
      anchorKeyword: "dec",
      anchorExclude: ["docs/**", "*.md"],
      scopeFollowRenames: "warn",
      hookIndex: "stage",
      commitSubject: "chore: {action} {title}",
    });
  });

  it.each([
    ["log = 1", "log must be a table"],
    ["policy = 1", "policy must be a table"],
    ["verify = 1", "verify must be a table"],
    ["scope = 1", "scope must be a table"],
    ["hooks = 1", "hooks must be a table"],
    ["commit = 1", "commit must be a table"],
    [
      '[log]\ndefault_template = "Nygard"',
      "log.default_template must be a template name matching ^[a-z][a-z0-9-]*$",
    ],
    [
      `[log]\ndefault_template = "${"a".repeat(65)}"`,
      "log.default_template must be a template name matching ^[a-z][a-z0-9-]*$",
    ],
    [
      "[log]\ndefault_template = 1",
      "log.default_template must be a template name matching ^[a-z][a-z0-9-]*$",
    ],
    ['[log]\nmain_branch = "-x"', "log.main_branch must be a ref name that doesn't start with -"],
    ['[log]\nindex = "always"', 'log.index must be "committed" or "none"'],
    ['[policy]\nauto_commit = "yes"', "policy.auto_commit must be true or false"],
    ['[verify]\nfail_on = "never"', 'verify.fail_on must be "error" or "warning"'],
    ["[verify]\nfail_on = 1", 'verify.fail_on must be "error" or "warning"'],
    ['[scope]\nanchor_keyword = "Adr"', "scope.anchor_keyword must match ^[a-z][a-z0-9-]{0,31}$"],
    [
      `[scope]\nanchor_keyword = "${"a".repeat(33)}"`,
      "scope.anchor_keyword must match ^[a-z][a-z0-9-]{0,31}$",
    ],
    [
      '[scope]\nanchor_exclude = "docs/**"',
      "scope.anchor_exclude must be an array of at most 100 globs",
    ],
    [
      `[scope]\nanchor_exclude = [${'"a",'.repeat(101)}]`,
      "scope.anchor_exclude must be an array of at most 100 globs",
    ],
    ['[scope]\nanchor_exclude = ["a", 1]', "scope.anchor_exclude[1] must be a string"],
    ['[scope]\nanchor_exclude = ["/abs"]', "scope.anchor_exclude[0]: "],
    [
      '[hooks]\nscope_follow_renames = "always"',
      'hooks.scope_follow_renames must be "stage" or "warn" or "off"',
    ],
    ['[hooks]\nindex = "always"', 'hooks.index must be "check" or "stage"'],
    ["[commit]\nsubject = 1", "commit.subject must be a string"],
  ])("refuses %j", (toml, message) => {
    expect(() => shared(`${toml}\n`)).toThrow(`widget.toml: ${message}`);
  });

  it("accepts 100 anchor_exclude globs and a 64-character template name", () => {
    const globs = Array.from({ length: 100 }, (_, i) => `"g${i}"`).join(", ");
    expect(shared(`[scope]\nanchor_exclude = [${globs}]\n`).anchorExclude).toHaveLength(100);
    const name = "a".repeat(64);
    expect(shared(`[log]\ndefault_template = "${name}"\n`).defaultTemplate).toBe(name);
  });

  it("lists the index values in indexValues order", () => {
    expect(() =>
      shared('[log]\nindex = "always"\n', { ...OPTIONS, indexValues: ["none", "committed"] }),
    ).toThrow('widget.toml: log.index must be "none" or "committed"');
  });

  it("names <tool>.toml when neither the path nor the config names a file", () => {
    expect(() =>
      parseSharedKeys(toolConfigReader(config("log = 1\n"), null, "widget"), OPTIONS),
    ).toThrow("widget.toml: log must be a table");
  });

  it("reads [commit] with the tool's names", () => {
    const o = (length: number): SharedKeyOptions => ({
      ...OPTIONS,
      defaults: {
        ...OPTIONS.defaults,
        commit: { ...OPTIONS.defaults.commit, names: [{ length, vars: {} }] },
      },
    });
    const toml = '[commit]\nsubject = "docs(widget): {action} {title}"\n';
    expect(() => shared(toml, o(61))).not.toThrow();
    expect(() => shared(toml, o(62))).toThrow(
      "widget.toml: commit.subject leaves no room for the title",
    );
  });
});
