import { existsSync } from "node:fs";
import { chmod, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EventEnvelope } from "../envelope/types.js";
import { GitError } from "../errors.js";
import { writeEvent } from "../log/write.js";
import { exampleLayout } from "../testing/example-kind.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { installHooks } from "./install.js";

// The fake tools load the built package, like a real ark tool would.
const dist = (f: string) => new URL(`../../dist/${f}`, import.meta.url);
for (const f of ["index.js", "testing.js"]) {
  if (!existsSync(dist(f))) throw new Error(`dist/${f} is missing; run \`pnpm build\` first`);
}

/** `verify --staged` on `exampleKind`, as an ark tool's CLI would run it. */
const VERIFY_TOOL = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const { Git, exitCode, formatText, verifyLog } = await import(${JSON.stringify(dist("index.js").href)});
const { exampleKind, exampleLayout } = await import(${JSON.stringify(dist("testing.js").href)});
appendFileSync(".git/ark-ran", "widget\\n");
const git = await Git.open(process.cwd());
const findings = await verifyLog({
  git,
  kind: exampleKind,
  layout: exampleLayout,
  mode: { type: "staged" },
});
console.log(formatText(findings));
process.exit(exitCode(findings));
`;

/** A second tool that fails while `omega-fail` exists in the work tree. */
const OTHER_TOOL = `#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
appendFileSync(".git/ark-ran", "zeta\\n");
if (existsSync("omega-fail")) {
  console.log("zeta: failing on purpose");
  process.exit(1);
}
`;

function event(
  o: Partial<EventEnvelope> & Pick<EventEnvelope, "id" | "at" | "type">,
): EventEnvelope {
  return {
    envelope: "ledger/v1",
    kind: "widget",
    schema: "widget/v1",
    subject: "a7c2m9xd",
    actor: { kind: "human", name: "Ada" },
    data: {},
    ...o,
  };
}

const created = event({
  id: "01JAB3K9Z6Q8M2X7FQ0V4TQ8A1",
  at: "2026-03-14T12:02:11Z",
  type: "created",
  data: { title: "A widget" },
});
const noted = event({
  id: "01JAB3M0000000000000000NTE",
  at: "2026-03-15T09:00:00Z",
  type: "noted",
});

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});

async function setup(): Promise<TempRepo> {
  const r = await createTempRepo({ files: { "README.md": "hello\n" } });
  repos.push(r);
  for (const [tool, script] of [
    ["widget", VERIFY_TOOL],
    ["zeta", OTHER_TOOL],
  ] as const) {
    // A .mjs file, so node loads it as ESM, behind the extensionless name the shim calls.
    const file = join(r.root, "node_modules", ".bin", `${tool}.mjs`);
    await r.write(`node_modules/.bin/${tool}.mjs`, script);
    await chmod(file, 0o755);
    await symlink(`${tool}.mjs`, join(r.root, "node_modules", ".bin", tool));
  }
  await r.write(".gitignore", "node_modules/\nomega-fail\n");
  await r.stage(".gitignore");
  await r.commit("ignore tools");
  await installHooks(r.git, { tool: "widget" });
  await installHooks(r.git, { tool: "zeta", commands: { "pre-commit": ["check"] } });
  return r;
}

async function ran(r: TempRepo): Promise<string[]> {
  const path = join(r.git.gitDir, "ark-ran");
  const lines = existsSync(path) ? (await readFile(path, "utf8")).split("\n").filter(Boolean) : [];
  await rm(path, { force: true });
  return lines;
}

async function commitFails(r: TempRepo, message: string): Promise<GitError> {
  const e = await r.commit(message).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(GitError);
  return e as GitError;
}

describe("the pre-commit shim, end to end (AC 11)", () => {
  it("passes a new valid event and rejects a modified committed one", async () => {
    const r = await setup();
    const path = await writeEvent(r.git, exampleLayout, created, { stage: true });
    await r.commit("add a widget");
    expect(await ran(r)).toEqual(["widget", "zeta"]);

    await writeEvent(r.git, exampleLayout, noted, { stage: true });
    await r.commit("note the widget");
    expect(await ran(r)).toEqual(["widget", "zeta"]);

    await r.write(path, (await readFile(join(r.root, path), "utf8")).replace("A widget", "Edited"));
    await r.stage(path);
    const e = await commitFails(r, "edit history");
    expect(e.stderr).toContain(
      `${path}: error: event file was modified; event files are append-only`,
    );
    expect(e.stderr).toContain("[append-only/modified]");
    // Every tool runs, even after one failed.
    expect(await ran(r)).toEqual(["widget", "zeta"]);
  });

  it("fails when the second tool fails, after the first one ran", async () => {
    const r = await setup();
    await writeEvent(r.git, exampleLayout, created, { stage: true });
    await r.write("omega-fail", "");
    const e = await commitFails(r, "add a widget");
    expect(e.stderr).toContain("zeta: failing on purpose");
    expect(e.stderr).toContain("No findings.");
    expect(await ran(r)).toEqual(["widget", "zeta"]);

    await r.remove("omega-fail");
    await r.commit("add a widget");
    expect(await ran(r)).toEqual(["widget", "zeta"]);
  });
});
