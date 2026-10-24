import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  cliRepo,
  runAdr,
  seedDecision,
  seedSupersession,
  WRITE_KEYS,
} from "../test-support/cli.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
const FILES = {
  "src/orders/api.ts": "export {}\n",
  "src/payments/pay.ts": "export {}\n",
};
async function repo(files: Record<string, string> = FILES): Promise<TempRepo> {
  const r = await cliRepo(files);
  repos.push(r);
  return r;
}
async function git(r: TempRepo, ...args: string[]): Promise<string> {
  return Buffer.from((await r.git.run(args)).stdout).toString("utf8");
}

type View = { id: string; status: string; applies_to: string[] };
type WriteDoc = {
  format: string;
  command: string;
  ok: boolean;
  decision: View | null;
  affected: View[];
  written: string[];
  commit: string | null;
  findings: { rule: string; message: string }[];
  notes: string[];
};
function doc(stdout: string): WriteDoc {
  const d = JSON.parse(stdout) as WriteDoc;
  expect(d.format).toBe("adr-write/v1");
  expect(Object.keys(d).sort()).toEqual(WRITE_KEYS);
  return d;
}
function usageError(r: TempRepo, args: string[], message: string): void {
  const out = runAdr(r, ["--json", ...args]);
  expect(out.status, args.join(" ")).toBe(2);
  expect(JSON.parse(out.stdout)).toEqual({
    format: "ark-error/v1",
    error: { code: "usage", message },
  });
  expect(out.stderr).toBe(`adr: error: ${message}\n`);
}
const USAGE =
  "usage: adr scope <decision> ([--set <glob>]… | --clear | [--add <glob>]… [--remove <glob>]…) [--commit | --no-commit] [-m <message>] | scope [<decision>] --follow-renames";

// 01:140, 01:150–152, 01:221, design §3.2 and §6.8 (set operations).
describe("adr scope", { timeout: 90_000 }, () => {
  it("sets, adds, removes and clears globs, one whole-set event each", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Use Aurora for orders", { accept: false });
    const set = runAdr(r, [
      "scope",
      a,
      "--set",
      "src/payments/**",
      "--set",
      "src/orders/**",
      "--commit",
    ]);
    expect(set.status).toBe(0);
    expect(set.stderr).toBe("");
    const sha = (await git(r, "rev-parse", "--short=7", "HEAD")).trim();
    expect(set.stdout).toBe(
      [
        `Scope of ${a}: Use Aurora for orders`,
        "  + src/orders/**",
        "  + src/payments/**",
        "  = src/orders/**, src/payments/**",
        `Committed ${sha}.`,
        "",
      ].join("\n"),
    );
    expect(await git(r, "log", "-1", "--format=%B")).toBe(
      `docs(adr): set the scope of ${a}\n\nADR: ${a}\nADR-Event: scoped\n\n`,
    );
    const event = (await git(r, "show", "--name-only", "--format=", "HEAD")).trim();
    expect(await git(r, "show", `HEAD:${event}`)).toContain(
      "data:\n  set:\n    - src/orders/**\n    - src/payments/**\n",
    );

    const both = runAdr(r, [
      "scope",
      a,
      "--add",
      "src/orders/*.ts",
      "--remove",
      "src/payments/**",
      "--json",
    ]);
    expect(both.status).toBe(0);
    const d = doc(both.stdout);
    expect(d).toMatchObject({ command: "scope", ok: true, commit: null, notes: [] });
    expect(d.decision?.applies_to).toEqual(["src/orders/**", "src/orders/*.ts"]);
    expect(d.written).toHaveLength(1);

    const cleared = runAdr(r, ["scope", a, "--clear"]);
    expect(cleared.status).toBe(0);
    expect(cleared.stdout).toBe(
      [
        `Scope of ${a}: Use Aurora for orders`,
        "  - src/orders/**",
        "  - src/orders/*.ts",
        "  = no globs",
        "Staged; commit to record it.",
        "",
      ].join("\n"),
    );
  });

  it("writes nothing when the set doesn't change, and notes absent and present globs", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Use Aurora for orders", { accept: false });
    expect(runAdr(r, ["scope", a, "--set", "src/orders/**", "--commit"]).status).toBe(0);
    const head = await git(r, "rev-parse", "HEAD");
    const out = runAdr(r, [
      "scope",
      a,
      "--add",
      "src/orders/**",
      "--remove",
      "lib/**",
      "--commit",
      "--json",
    ]);
    expect(out.status).toBe(0);
    const notes = [
      `lib/** is not in the scope of ${a}`,
      `src/orders/** is already in the scope of ${a}`,
    ];
    expect(doc(out.stdout)).toMatchObject({ ok: true, written: [], commit: null, notes });
    expect(out.stderr).toBe(notes.map((n) => `adr: warning: ${n}\n`).join(""));
    expect(runAdr(r, ["scope", a, "--set", "src/orders/**"]).stdout).toBe(
      `Scope of ${a} unchanged: src/orders/**\n`,
    );
    expect(await git(r, "rev-parse", "HEAD")).toBe(head);
    expect(await git(r, "status", "--porcelain")).toBe("");
  });

  it("notes globs that match no tracked file, and a narrowed accepted scope", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Use Aurora for orders");
    const out = runAdr(r, [
      "scope",
      "ADR-0001",
      "--set",
      "src/orders/**",
      "--set",
      "src/shared/**",
      "--json",
    ]);
    expect(out.status).toBe(0);
    expect(doc(out.stdout).notes).toEqual([
      "src/shared/** matches no tracked file; verify (hooks and CI) reports scope/glob-unmatched until a file matches",
    ]);
    const narrowed = runAdr(r, ["scope", a, "--remove", "src/shared/**"]);
    expect(narrowed.status).toBe(0);
    expect(narrowed.stderr).toBe(
      "adr: warning: this narrows the scope of an accepted decision; if its Scope section no longer reads true, propose a superseding decision instead\n",
    );
    expect(narrowed.stdout).toBe(
      [
        `Scope of ADR-0001 (${a}): Use Aurora for orders`,
        "  - src/shared/**",
        "  = src/orders/**",
        "Staged; commit to record it.",
        "",
      ].join("\n"),
    );
  });

  it("leaves verify out of the note for a deprecated decision, whose globs aren't checked", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Use Aurora for orders");
    expect(runAdr(r, ["deprecate", a, "--reason", "Old.", "--commit"]).status).toBe(0);
    const out = runAdr(r, ["scope", a, "--set", "src/shared/**", "--json"]);
    expect(out.status).toBe(0);
    expect(doc(out.stdout).notes).toEqual(["src/shared/** matches no tracked file"]);
  });

  it("exits 1 for a superseded decision, with nothing written", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Use DynamoDB for orders");
    const b = await seedDecision(r, "Use Aurora for orders");
    await seedSupersession(r, a, b);
    const out = runAdr(r, ["scope", a, "--add", "src/**", "--json"]);
    expect(out.status).toBe(1);
    expect(doc(out.stdout)).toMatchObject({ ok: false, written: [], commit: null });
    expect(doc(out.stdout).findings).toEqual([
      expect.objectContaining({
        rule: "transition/illegal",
        message: "scoped is not allowed while superseded; superseded is terminal",
      }),
    ]);
    expect(runAdr(r, ["scope", a, "--add", "src/**"]).stdout).toBe(
      `Not scoped: ADR-0001: Use DynamoDB for orders\n  docs/adr/decisions/${a}-use-dynamodb-for-orders.md: scoped is not allowed while superseded; superseded is terminal [transition/illegal]\n`,
    );
    expect(await git(r, "status", "--porcelain")).toBe("");
  });

  it("exits 2 for invalid globs and conflicting or missing arguments", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Use Aurora for orders", { accept: false });
    usageError(
      r,
      ["scope", a, "--add", "/src/**"],
      'invalid glob "/src/**": globs are relative to the repository root; remove the leading /',
    );
    usageError(
      r,
      ["scope", a, "--set", "a/**", "--add", "b/**"],
      "--set can't be combined with --add or --remove",
    );
    usageError(
      r,
      ["scope", a, "--clear", "--set", "a/**"],
      "--clear can't be combined with --set, --add or --remove",
    );
    usageError(
      r,
      ["scope", a, "--add", "a/**", "--remove", "a/**"],
      "glob a/** is both added and removed",
    );
    usageError(r, ["scope", a], "nothing to change: give --set, --add, --remove or --clear");
    usageError(r, ["scope", a, "--set", "a", "b"], `unexpected argument "b"; ${USAGE}`);
    usageError(r, ["scope", "--add", "x"], `missing argument <decision>; ${USAGE}`);
    usageError(r, ["scope", "ADR-0042", "--add", "x"], "unknown decision ADR-0042");
    expect(await git(r, "status", "--porcelain")).toBe("");
  });
});

const RENAME_FILES = {
  "src/orders/api.ts": "export const api = 1;\n",
  "src/orders/db.ts": "export const db = 1;\n",
  "src/payments/pay.ts": "export const pay = 1;\n",
  "lib/util.ts": "export const util = 1;\n",
};

/** ADR-0001 scoped to `src/orders/**`, ADR-0002 to `src/orders/api.ts`, both committed. */
async function renameRepo(files: Record<string, string> = {}) {
  const r = await repo({ ...RENAME_FILES, ...files });
  const a = await seedDecision(r, "Use Aurora for orders");
  expect(runAdr(r, ["scope", a, "--set", "src/orders/**", "--commit"]).status).toBe(0);
  const b = await seedDecision(r, "Keep the order API stable");
  expect(runAdr(r, ["scope", b, "--set", "src/orders/api.ts", "--commit"]).status).toBe(0);
  return { r, a, b };
}
const mv = (r: TempRepo, from: string, to: string) => git(r, "mv", from, to);
const FOLLOW_NOTE = "--follow-renames never commits; commit the scoped events with the renames";

// 01:221, 01:340, design §6.8 --follow-renames and its §16.4 rows.
describe("adr scope --follow-renames", { timeout: 120_000 }, () => {
  it("prints one line per changed decision when no decision is given (design-review L1)", async () => {
    const { r, a, b } = await renameRepo();
    await mv(r, "src/orders", "src/billing");
    const head = await git(r, "rev-parse", "HEAD");
    const out = runAdr(r, ["scope", "--follow-renames"]);
    expect(out.status).toBe(0);
    expect(out.stderr).toBe("");
    expect(out.stdout).toBe(
      [
        ...(
          [
            [a, `ADR-0001 (${a}): src/orders/** → src/billing/**`],
            [b, `ADR-0002 (${b}): src/orders/api.ts → src/billing/api.ts`],
          ] as const
        )
          .slice()
          .sort(([x], [y]) => (x < y ? -1 : 1))
          .map(([, line]) => line),
        "Staged; commit the scoped events with the renames.",
        "",
      ].join("\n"),
    );
    expect(await git(r, "rev-parse", "HEAD")).toBe(head);
    const staged = (await git(r, "diff", "--cached", "--name-only")).split("\n");
    expect(staged.filter((p) => p.endsWith("-scoped.yaml"))).toHaveLength(2);
  });

  it("reports both decisions in affected and a null decision under --json", async () => {
    const { r, a, b } = await renameRepo();
    await mv(r, "src/orders", "src/billing");
    const out = runAdr(r, ["scope", "--follow-renames", "--json"]);
    expect(out.status).toBe(0);
    const d = doc(out.stdout);
    expect(d).toMatchObject({
      command: "scope",
      ok: true,
      decision: null,
      commit: null,
      notes: [],
    });
    expect(d.written).toHaveLength(2);
    expect(Object.fromEntries(d.affected.map((v) => [v.id, v.applies_to]))).toEqual({
      [a]: ["src/billing/**"],
      [b]: ["src/billing/api.ts"],
    });
  });

  it("follows only the decision given", async () => {
    const { r, a } = await renameRepo();
    await mv(r, "src/orders", "src/billing");
    const out = runAdr(r, ["scope", "1", "--follow-renames", "--json"]);
    expect(out.status).toBe(0);
    const d = doc(out.stdout);
    expect(d.decision).toMatchObject({ id: a, applies_to: ["src/billing/**"] });
    expect(d.affected.map((v) => v.id)).toEqual([a]);
    expect(d.written).toHaveLength(1);
  });

  it("writes nothing without staged renames, or when no glob follows them", async () => {
    const { r } = await renameRepo();
    const none = runAdr(r, ["scope", "--follow-renames"]);
    expect(none).toMatchObject({ status: 0, stdout: "No staged renames.\n", stderr: "" });
    const empty = { ok: true, decision: null, affected: [], written: [], commit: null, notes: [] };
    expect(doc(runAdr(r, ["scope", "--follow-renames", "--json"]).stdout)).toMatchObject(empty);
    await mv(r, "lib/util.ts", "lib/helpers.ts");
    const untouched = runAdr(r, ["scope", "--follow-renames"]);
    expect(untouched.stdout).toBe("No scope globs follow the staged renames.\n");
    expect(doc(runAdr(r, ["scope", "--follow-renames", "--json"]).stdout)).toMatchObject(empty);
    expect((await git(r, "diff", "--cached", "--name-only")).trim()).toBe(
      "lib/helpers.ts\nlib/util.ts",
    );
  });

  it("notes inactive decisions only when the renames would change their scope", async () => {
    const r = await repo(RENAME_FILES);
    const old = await seedDecision(r, "Use DynamoDB for payments");
    expect(runAdr(r, ["scope", old, "--set", "src/payments/**", "--commit"]).status).toBe(0);
    const other = await seedDecision(r, "Use Redis for the library");
    expect(runAdr(r, ["scope", other, "--set", "lib/**", "--commit"]).status).toBe(0);
    const by = await seedDecision(r, "Use Aurora for payments");
    await seedSupersession(r, old, by);
    await seedSupersession(r, other, by);
    const rejected = await seedDecision(r, "Use files", { accept: false });
    expect(runAdr(r, ["reject", rejected, "--reason", "No", "--commit"]).status).toBe(0);
    await mv(r, "src/payments", "src/pay");
    const out = runAdr(r, ["scope", "--follow-renames", "--json"]);
    expect(out.status).toBe(0);
    const note = `ADR-0001 (${old}) is superseded; its scope can't follow renames (1 renamed files leave it)`;
    expect(doc(out.stdout)).toMatchObject({ affected: [], written: [], notes: [note] });
    expect(out.stderr).toBe(`adr: warning: ${note}\n`);

    const explicit = runAdr(r, ["scope", old, "--follow-renames", "--json"]);
    expect(explicit.status).toBe(1);
    expect(doc(explicit.stdout).findings.map((f) => f.rule)).toEqual(["transition/illegal"]);
  });

  it("stages and never commits under auto_commit, with a note", async () => {
    const { r, a, b } = await renameRepo({
      "docs/adr/adr.toml": "[policy]\nauto_commit = true\n",
    });
    await mv(r, "src/orders", "src/billing");
    const head = await git(r, "rev-parse", "HEAD");
    const out = runAdr(r, ["scope", "--follow-renames", "--json"]);
    expect(out.status).toBe(0);
    const d = doc(out.stdout);
    expect(d).toMatchObject({ ok: true, commit: null, notes: [FOLLOW_NOTE] });
    expect(d.affected.map((v) => v.id).sort()).toEqual([a, b].sort());
    expect(await git(r, "rev-parse", "HEAD")).toBe(head);
    expect(out.stderr).toBe(`adr: warning: ${FOLLOW_NOTE}\n`);
  });

  it("exits 2 with --commit, -m or a set operation", async () => {
    const { r, a } = await renameRepo({ "docs/adr/adr.toml": "[policy]\nauto_commit = true\n" });
    usageError(
      r,
      ["scope", "--follow-renames", "--commit"],
      "--follow-renames stages its events for the commit that contains the renames; commit them together",
    );
    usageError(
      r,
      ["scope", "--follow-renames", "-m", "x"],
      "--follow-renames never commits, so it takes no --message",
    );
    usageError(
      r,
      ["scope", a, "--follow-renames", "--add", "x/**"],
      "--follow-renames can't be combined with --set, --clear, --add or --remove",
    );
    usageError(
      r,
      ["scope", a, "--follow-renames", "--clear"],
      "--follow-renames can't be combined with --set, --clear, --add or --remove",
    );
  });
});
