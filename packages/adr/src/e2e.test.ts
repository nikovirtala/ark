import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type EventEnvelope,
  eventPath,
  nextEventIdentity,
  parseEventYaml,
  serializeEvent,
} from "@nikovirtala/ledger";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, expect, it } from "vitest";
import { adrKind } from "./kind.js";
import { cliRepo, runAdr } from "./test-support/cli.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function git(r: TempRepo, ...args: string[]): Promise<string> {
  return Buffer.from((await r.git.run(args)).stdout).toString("utf8");
}

const SECTIONS = [
  "--section",
  "context=Orders",
  "--section",
  "decision=Pick",
  "--section",
  "scope=services/orders",
  "--section",
  "consequences=Ops",
];
const LAYOUT = adrKind.layoutAt("docs/adr");

// AC 12: the plan's end-to-end demo against the built binary, in one test.
it("proposes, accepts, supersedes, lists, shows and verifies decisions", {
  timeout: 120_000,
}, async () => {
  const r = await cliRepo();
  repos.push(r);
  const ok = (args: string[]) => {
    const out = runAdr(r, args);
    expect(out.status, `adr ${args.join(" ")}: ${out.stderr}`).toBe(0);
    return out;
  };
  const verifyHead = () => expect(ok(["verify", "--ref", "HEAD"]).stdout).toBe("No findings.\n");

  // new: a decision file and a proposed event, both staged, plus the materialized template.
  const id1 = JSON.parse(ok(["new", "Use DynamoDB for orders", ...SECTIONS, "--json"]).stdout)
    .decision.id as string;
  const status = (await git(r, "status", "--porcelain")).split("\n").filter((l) => l !== "");
  expect(status).toEqual([
    `A  docs/adr/decisions/${id1}-use-dynamodb-for-orders.md`,
    expect.stringMatching(new RegExp(`^A {2}docs/adr/events/${id1}/\\S+-proposed\\.yaml$`)),
    "A  docs/adr/templates/nygard.md",
  ]);

  // accept --commit: one commit with the body, both events and the template, exact trailers.
  const acceptDoc = JSON.parse(ok(["accept", id1, "--commit", "--json"]).stdout);
  expect(acceptDoc).toMatchObject({
    format: "adr-write/v1",
    ok: true,
    decision: { id: id1, number: 1, display: "ADR-0001" },
  });
  const files = (await git(r, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"))
    .split("\n")
    .filter((l) => l !== "");
  // Event files of one second sort by their random suffix, so compare without the order.
  expect(files).toHaveLength(4);
  expect(files).toEqual(
    expect.arrayContaining([
      `docs/adr/decisions/${id1}-use-dynamodb-for-orders.md`,
      expect.stringMatching(new RegExp(`^docs/adr/events/${id1}/\\S+-proposed\\.yaml$`)),
      expect.stringMatching(new RegExp(`^docs/adr/events/${id1}/\\S+-accepted\\.yaml$`)),
      "docs/adr/templates/nygard.md",
    ]),
  );
  expect(await git(r, "log", "-1", "--format=%(trailers:only,unfold)")).toBe(
    `ADR: ${id1}\nADR-Event: proposed\nADR: ${id1}\nADR-Event: accepted\n\n`,
  );
  expect(await git(r, "log", "-1", "--format=%s")).toBe(
    "docs(adr): decide to use DynamoDB for orders\n",
  );
  expect(ok(["list"]).stdout).toBe(`ADR-0001  ${id1}  accepted  Use DynamoDB for orders\n`);
  verifyHead();

  // A second decision is ADR-0002.
  const id2 = JSON.parse(ok(["new", "Use Aurora for orders", ...SECTIONS, "--json"]).stdout)
    .decision.id as string;
  ok(["accept", id2, "--commit"]);
  expect(ok(["list"]).stdout).toBe(
    [
      `ADR-0001  ${id1}  accepted  Use DynamoDB for orders`,
      `ADR-0002  ${id2}  accepted  Use Aurora for orders`,
      "",
    ].join("\n"),
  );
  verifyHead();

  // supersede: show leads with the warning.
  const supersedeDoc = JSON.parse(
    ok(["supersede", "ADR-0001", "--by", "ADR-0002", "--commit", "--json"]).stdout,
  );
  expect(supersedeDoc).toMatchObject({
    decision: { id: id1, display: "ADR-0001", status: "superseded", effective: id2 },
    affected: [{ id: id1, display: "ADR-0001", status: "superseded" }],
  });
  expect(await git(r, "log", "-1", "--format=%s")).toBe(
    "docs(adr): supersede ADR-0001 with ADR-0002\n",
  );
  verifyHead();
  const show = ok(["show", "ADR-0001"]).stdout.split("\n");
  expect(show[0]).toBe(`ADR-0001 (${id1}) · superseded`);
  expect(show[1]).toMatch(/^SUPERSEDED by ADR-0002 \(accepted \d{4}-\d\d-\d\d\)\. /);
  const shown = JSON.parse(ok(["show", "ADR-0001", "--json"]).stdout);
  expect(shown).toMatchObject({
    format: "adr-show/v1",
    decision: { id: id1, display: "ADR-0001", status: "superseded", effective: id2 },
  });
  const listed = JSON.parse(ok(["list", "--json"]).stdout);
  expect(listed.format).toBe("adr-list/v1");
  expect(listed.decisions.map((v: { status: string }) => v.status)).toEqual([
    "superseded",
    "accepted",
  ]);
  expect(ok(["verify"]).stdout).toBe("No findings.\n");

  // Tamper 1: an edited accepted body.
  const body = join(r.root, `docs/adr/decisions/${id2}-use-aurora-for-orders.md`);
  const original = await readFile(body);
  await appendFile(body, "tampered\n");
  const tampered = runAdr(r, ["verify"]);
  expect(tampered.status).toBe(1);
  expect(tampered.stdout).toContain("[body/hash-mismatch]");
  await writeFile(body, original);

  // Tamper 2: a hand-written accepted event on the superseded ADR-0001.
  const dir = join(r.root, "docs/adr/events", id1);
  const events: EventEnvelope[] = [];
  for (const f of await readdir(dir)) {
    const parsed = parseEventYaml(await readFile(join(dir, f)), { file: f });
    if (parsed.ok) events.push(parsed.doc as unknown as EventEnvelope);
  }
  const accepted = events.find((e) => e.type === "accepted");
  const last = Math.max(...events.map((e) => Date.parse(e.at)));
  const { at, id } = nextEventIdentity(events, { now: () => last + 1000 });
  const illegal = { ...(accepted as EventEnvelope), at, id };
  await writeFile(join(r.root, eventPath(LAYOUT, illegal)), serializeEvent(illegal));
  const verified = runAdr(r, ["verify"]);
  expect(verified.status).toBe(1);
  expect(verified.stdout).toContain(
    "accepted is not allowed while superseded; superseded is terminal [transition/illegal]",
  );

  // Bad usage: exit 2 with a message on stderr; with --json an ark-error/v1 document.
  for (const args of [
    ["frobnicate"],
    ["show"],
    ["list", "--bogus"],
    ["accept", id1, "--ref", "HEAD"],
    ["verify", "--staged", "--base", "main"],
  ]) {
    const out = runAdr(r, args);
    expect(out.status, args.join(" ")).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toMatch(/^adr: error: /);
    const json = runAdr(r, ["--json", ...args]);
    expect(json.status).toBe(2);
    expect(JSON.parse(json.stdout)).toEqual({
      format: "ark-error/v1",
      error: { code: "usage", message: out.stderr.replace(/^adr: error: /, "").trimEnd() },
    });
  }
});
