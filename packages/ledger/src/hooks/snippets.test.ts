import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { InvalidArgumentError } from "../errors.js";
import type { HookRegistration } from "./shim.js";
import { hookSnippet } from "./snippets.js";

const regs: HookRegistration[] = [
  { tool: "issues", hook: "pre-commit", argv: ["verify", "--staged"] },
  { tool: "adr", hook: "pre-commit", argv: ["verify", "--staged"] },
  { tool: "issues", hook: "commit-msg", argv: ["trailers", "{args}"] },
];

describe("hookSnippet", () => {
  it("renders lefthook config", () => {
    const text = hookSnippet("lefthook", regs);
    expect(text).toBe(`# lefthook.yml
pre-commit:
  commands:
    adr-verify:
      run: npx --no-install adr verify --staged
    issues-verify:
      run: npx --no-install issues verify --staged
commit-msg:
  commands:
    issues-trailers:
      run: "npx --no-install issues trailers {0}"
`);
    expect(parse(text)["commit-msg"].commands["issues-trailers"].run).toBe(
      "npx --no-install issues trailers {0}",
    );
  });

  it("renders husky hook files", () => {
    expect(hookSnippet("husky", regs)).toBe(`# .husky/pre-commit
adr verify --staged
issues verify --staged

# .husky/commit-msg
issues trailers "$@"
`);
  });

  it("renders pre-commit framework config", () => {
    const text = hookSnippet("pre-commit", regs);
    expect(text).toBe(`# .pre-commit-config.yaml
repos:
  - repo: local
    hooks:
      - id: adr-verify
        name: adr verify --staged
        entry: npx --no-install adr verify --staged
        language: system
        pass_filenames: false
        always_run: true
        stages: [pre-commit]
      - id: issues-verify
        name: issues verify --staged
        entry: npx --no-install issues verify --staged
        language: system
        pass_filenames: false
        always_run: true
        stages: [pre-commit]
      - id: issues-trailers
        name: issues trailers
        entry: npx --no-install issues trailers
        language: system
        pass_filenames: true
        always_run: true
        stages: [commit-msg]
`);
    expect(parse(text).repos[0].hooks).toHaveLength(3);
  });

  it("quotes argv for sh and yaml", () => {
    const tricky: HookRegistration[] = [
      { tool: "adr", hook: "pre-commit", argv: ["verify", "--format", "it's: a #test"] },
    ];
    expect(hookSnippet("husky", tricky)).toBe(
      "# .husky/pre-commit\nadr verify --format 'it'\\''s: a #test'\n",
    );
    const lefthook = parse(hookSnippet("lefthook", tricky));
    expect(lefthook["pre-commit"].commands["adr-verify"].run).toBe(
      "npx --no-install adr verify --format 'it'\\''s: a #test'",
    );
    const preCommit = parse(hookSnippet("pre-commit", tricky));
    expect(preCommit.repos[0].hooks[0].entry).toBe(
      "npx --no-install adr verify --format 'it'\\''s: a #test'",
    );
  });

  it("passes the hook's arguments to pre-commit only last", () => {
    expect(() =>
      hookSnippet("pre-commit", [{ tool: "adr", hook: "commit-msg", argv: ["{args}", "x"] }]),
    ).toThrow(InvalidArgumentError);
  });
});
