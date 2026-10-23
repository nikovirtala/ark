import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES } from "../templates/builtin.js";
import { cliRepo, runAdr } from "../test-support/cli.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(files: Record<string, string> = {}): Promise<TempRepo> {
  const r = await cliRepo(files);
  repos.push(r);
  return r;
}
async function git(r: TempRepo, ...args: string[]): Promise<string> {
  return Buffer.from((await r.git.run(args)).stdout).toString("utf8");
}
const read = (r: TempRepo, path: string) => readFile(join(r.root, path), "utf8");

const INIT_KEYS = ["commit", "config", "format", "kept", "notes", "root", "written"];
type InitDoc = {
  format: string;
  root: string;
  config: string | null;
  written: string[];
  kept: string[];
  commit: string | null;
  notes: string[];
};
function doc(stdout: string): InitDoc {
  const d = JSON.parse(stdout) as InitDoc;
  expect(d.format).toBe("adr-init/v1");
  expect(Object.keys(d).sort()).toEqual(INIT_KEYS);
  return d;
}

const config = (lines: readonly string[]) =>
  [
    "# adr configuration. Every key is optional: https://github.com/nikovirtala/ark/tree/main/packages/adr#config-adrtoml",
    "[log]",
    ...lines,
    "",
    "[commit]",
    '# subject = "docs(adr): {action} {title}"',
    "",
  ].join("\n");

// 01:212, 01:315, design §6.2 and its §16.4 row.
describe("adr init", { timeout: 60_000 }, () => {
  it("writes and stages a config and the nygard template, and keeps them on a second run", async () => {
    const r = await repo();
    const out = runAdr(r, ["init"]);
    expect(out).toEqual({
      status: 0,
      stdout: [
        "Initialized docs/adr",
        "  docs/adr/adr.toml",
        "  docs/adr/templates/nygard.md",
        'Next: adr new "<title>"',
        "",
      ].join("\n"),
      stderr: "",
    });
    expect(await read(r, "docs/adr/adr.toml")).toBe(config(['default_template = "nygard"']));
    expect(await read(r, "docs/adr/templates/nygard.md")).toBe(BUILTIN_TEMPLATES.nygard);
    expect(await git(r, "diff", "--cached", "--name-only")).toBe(
      "docs/adr/adr.toml\ndocs/adr/templates/nygard.md\n",
    );

    const again = runAdr(r, ["init", "--json"]);
    expect(again.status).toBe(0);
    expect(doc(again.stdout)).toEqual({
      format: "adr-init/v1",
      root: "docs/adr",
      config: "docs/adr/adr.toml",
      written: [],
      kept: ["docs/adr/adr.toml", "docs/adr/templates/nygard.md"],
      commit: null,
      notes: [],
    });
    expect(runAdr(r, ["init", "--commit", "-m", "chore: unused"]).stdout).toBe(
      "Already initialized: docs/adr (kept docs/adr/adr.toml, docs/adr/templates/nygard.md)\n",
    );
  });

  it("commits only what it wrote with a conventional subject, and writes each template once", async () => {
    const r = await repo();
    await r.write("staged.txt", "x\n");
    await r.stage("staged.txt");
    const out = runAdr(r, [
      "init",
      "--template",
      "madr",
      "--template",
      "y-statement",
      "--template",
      "madr",
      "--commit",
      "--json",
    ]);
    expect(out.status).toBe(0);
    const d = doc(out.stdout);
    expect(d.written).toEqual([
      "docs/adr/adr.toml",
      "docs/adr/templates/madr.md",
      "docs/adr/templates/y-statement.md",
    ]);
    expect(d.commit).toBe((await git(r, "rev-parse", "HEAD")).trim());
    expect(await git(r, "log", "-1", "--format=%B")).toBe("docs(adr): set up the decision log\n\n");
    expect(await git(r, "show", "--name-only", "--format=", "HEAD")).toBe(
      `${d.written.join("\n")}\n`,
    );
    expect(await git(r, "diff", "--cached", "--name-only")).toBe("staged.txt\n");
    expect(await read(r, "docs/adr/adr.toml")).toBe(config(['default_template = "madr"']));

    const nygard = runAdr(r, [
      "init",
      "--template",
      "nygard",
      "--commit",
      "-m",
      "chore: add nygard",
    ]);
    expect(nygard.stdout).toMatch(
      /^Initialized docs\/adr\n {2}docs\/adr\/templates\/nygard\.md\nKept docs\/adr\/adr\.toml\nCommitted [0-9a-f]{7}\.\n/,
    );
    expect(await git(r, "log", "-1", "--format=%s")).toBe("chore: add nygard\n");
  });

  it("names a --root log in a repo-level adr.toml, so later commands find it", async () => {
    const r = await repo();
    const out = runAdr(r, ["init", "--root", "lib/decisions", "--json"]);
    expect(doc(out.stdout)).toMatchObject({
      root: "lib/decisions",
      config: "adr.toml",
      written: ["adr.toml", "lib/decisions/templates/nygard.md"],
      notes: [],
    });
    expect(await read(r, "adr.toml")).toBe(
      config(['root = "lib/decisions"', 'default_template = "nygard"']),
    );
    const created = runAdr(r, [
      "new",
      "Use Aurora",
      "--section",
      "context=a",
      "--section",
      "decision=b",
      "--section",
      "scope=c",
      "--section",
      "consequences=d",
      "--json",
    ]);
    expect(JSON.parse(created.stdout).written[0]).toMatch(/^lib\/decisions\/decisions\//);
  });

  it("writes the config in the root when the repo adr.toml names another log", async () => {
    const r = await repo({ "adr.toml": '[log]\nroot = "docs/adr"\n' });
    const out = runAdr(r, ["init", "--root", "lib/decisions", "--json"]);
    expect(out.status).toBe(0);
    const d = doc(out.stdout);
    expect(d).toMatchObject({
      config: "lib/decisions/adr.toml",
      written: ["lib/decisions/adr.toml", "lib/decisions/templates/nygard.md"],
      notes: [
        "ignoring adr.toml (its root is docs/adr; --root is lib/decisions)",
        "adr.toml names docs/adr; pass --root lib/decisions to use this log",
      ],
    });
    expect(await read(r, "adr.toml")).toBe('[log]\nroot = "docs/adr"\n');
    expect(await read(r, "lib/decisions/adr.toml")).toBe(config(['default_template = "nygard"']));
  });

  it("exits 2 for an unknown template and for --ref, writing nothing", async () => {
    const r = await repo();
    for (const [args, message] of [
      [
        ["init", "--template", "team"],
        "unknown built-in template team; use nygard, madr or y-statement",
      ],
      [["init", "--ref", "HEAD"], "init does not take --ref; it works on the work tree"],
      [["init", "-m", "x"], "--message needs --commit (or [policy] auto_commit = true)"],
    ] as const) {
      const out = runAdr(r, ["--json", ...args]);
      expect(out.status, args.join(" ")).toBe(2);
      expect(JSON.parse(out.stdout)).toEqual({
        format: "ark-error/v1",
        error: { code: "usage", message },
      });
    }
    expect(await git(r, "status", "--porcelain")).toBe("");
  });
});
