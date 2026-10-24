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

// plan §3, design §16.4: the phase 2a demo against the built binary, asserting exit codes, JSON
// documents and commit subjects rather than whole text output.
it("runs the phase 2a demo: init, scope, for, renames, copy-scope, lifecycle, agents", {
  timeout: 240_000,
}, async () => {
  const r = await cliRepo({
    "src/orders/api.ts": "export {}\n",
    "src/payments/pay.ts": "export {}\n",
  });
  repos.push(r);
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => runAdr(r, args, { env });
  const ok = (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const out = run(args, env);
    expect(out.status, `adr ${args.join(" ")}: ${out.stderr}`).toBe(0);
    return out;
  };
  const json = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    JSON.parse(ok(["--json", ...args], env).stdout);
  const subject = async () => (await git(r, "log", "-1", "--format=%s")).trim();
  const proposed = () =>
    (json(["list"]).decisions as { id: string; status: string }[]).filter(
      (d) => d.status === "proposed",
    );

  // init --commit
  expect(json(["init", "--commit"])).toMatchObject({
    format: "adr-init/v1",
    written: ["docs/adr/adr.toml", "docs/adr/templates/nygard.md"],
  });
  expect(await subject()).toBe("docs(adr): set up the decision log");

  // new --no-edit --commit with an unfilled section: refused, nothing written
  const half = run(["new", "Half done", ...SECTIONS.slice(0, 6), "--no-edit", "--commit"]);
  expect(half.status).toBe(1);
  expect(half.stdout).toContain("Not proposed: Half done");
  expect(await git(r, "status", "--porcelain")).toBe("");

  // new --commit: a Conventional subject, trailers last
  const a = json(["new", "Use DynamoDB for orders", ...SECTIONS, "--no-edit", "--commit"]).decision
    .id as string;
  expect(await subject()).toBe("docs(adr): propose to use DynamoDB for orders");
  expect(await git(r, "log", "-1", "--format=%(trailers:only,unfold)")).toBe(
    `ADR: ${a}\nADR-Event: proposed\n\n`,
  );

  // scope: set, add and remove with notes, commit
  ok(["scope", a, "--set", "src/orders/**", "--set", "src/payments/**", "--commit"]);
  expect(await subject()).toBe(`docs(adr): set the scope of ${a}`);
  const added = run(["scope", a, "--add", "src/shared/**", "--remove", "src/payments/**"]);
  expect(added.status).toBe(0);
  expect(added.stderr).toBe(
    "adr: warning: src/shared/** matches no tracked file; verify (hooks and CI) reports scope/glob-unmatched until a file matches\n",
  );
  ok(["scope", a, "--remove", "src/shared/**", "--commit"]);
  expect(json(["show", a]).decision.applies_to).toEqual(["src/orders/**"]);
  const forOrders = json(["for", "src/orders/api.ts"]);
  expect(forOrders.format).toBe("adr-for/v1");
  expect(forOrders.paths[0].decisions.map((d: { id: string }) => d.id)).toEqual([a]);

  // accept, then a git mv followed by --follow-renames
  ok(["accept", a, "--commit"]);
  expect(await subject()).toBe("docs(adr): decide to use DynamoDB for orders");
  await git(r, "mv", "src/orders", "src/billing");
  const followed = json(["scope", "--follow-renames"]);
  expect(followed).toMatchObject({ command: "scope", decision: null, commit: null });
  expect(followed.affected.map((v: { applies_to: string[] }) => v.applies_to)).toEqual([
    ["src/billing/**"],
  ]);
  expect(json(["for", "src/billing/api.ts"]).paths[0].decisions[0].id).toBe(a);
  await r.commit("refactor: move orders to billing");

  // a superseding decision: non-TTY accept suggests the adr scope command
  const b = json([
    "new",
    "Use Aurora for orders",
    ...SECTIONS,
    "--supersedes",
    a,
    "--no-edit",
    "--commit",
  ]).decision.id as string;
  const acceptB = run(["accept", b, "--commit"]);
  expect(acceptB.status).toBe(0);
  expect(acceptB.stderr).toBe(
    `adr: warning: not copying the scope of ADR-0001 (1 glob); to copy it: adr scope ${b} --add 'src/billing/**'\n`,
  );
  expect(json(["show", b]).decision).toMatchObject({ status: "accepted", applies_to: [] });

  // --json and --copy-scope on a second superseding pair
  const c = json([
    "new",
    "Use Postgres for orders",
    ...SECTIONS,
    "--supersedes",
    b,
    "--no-edit",
    "--commit",
  ]).decision.id as string;
  ok(["scope", b, "--set", "src/billing/**", "--commit"]);
  const acceptC = json(["accept", c, "--copy-scope", "--commit"]);
  expect(acceptC).toMatchObject({
    ok: true,
    notes: [],
    decision: { applies_to: ["src/billing/**"] },
  });
  expect(await git(r, "log", "-1", "--format=%b")).toContain("Copies the scope of ADR-0002.\n");

  // reject (exit 2 without a reason), withdraw, deprecate, note, link, -m
  ok(["new", "Adopt GraphQL federation", ...SECTIONS, "--no-edit", "--commit"]);
  const g = proposed()[0]?.id ?? "";
  expect(run(["reject", g, "--commit"]).status).toBe(2);
  ok(["reject", g, "--reason", "Too early", "--commit"]);
  expect(await subject()).toBe("docs(adr): decide not to adopt GraphQL federation");
  ok(["new", "Cache order reads", ...SECTIONS, "--no-edit", "--commit"]);
  const w = proposed()[0]?.id ?? "";
  ok(["withdraw", w, "--commit"]);
  expect(await subject()).toBe("docs(adr): withdraw the proposal to cache order reads");
  ok(["deprecate", c, "--reason", "Moving to a managed service", "--commit"]);
  expect(await subject()).toBe("docs(adr): deprecate ADR-0003");
  ok(["note", c, "Benchmarks in the wiki", "--commit"]);
  expect(await subject()).toBe("docs(adr): add a note to ADR-0003");
  ok(["link", c, a, "--rel", "refines", "--commit"]);
  expect(await subject()).toBe("docs(adr): link ADR-0003 to ADR-0001");
  ok(["note", c, "Custom message demo", "--commit", "-m", "docs: record the benchmark link"]);
  expect(await git(r, "log", "-1", "--format=%B")).toBe(
    `docs: record the benchmark link\n\nADR: ${c}\nADR-Event: noted\n\n`,
  );

  // agents: the git-identity note, ARK_ON_BEHALF_OF, an invalid address
  const agent = { ARK_AGENT: "kiro" };
  const one = run(["new", "Agent proposal one", ...SECTIONS, "--no-edit", "--commit"], agent);
  expect(one.status).toBe(0);
  expect(one.stderr).toContain("on_behalf_of taken from the git identity ledger-test@example.com");
  expect(one.stdout).toContain("Next: ask a human to review and accept it (adr accept ");
  const two = run(["new", "Agent proposal two", ...SECTIONS, "--no-edit", "--commit"], {
    ...agent,
    ARK_ON_BEHALF_OF: "demo@example.com",
  });
  expect(two).toMatchObject({ status: 0, stderr: "" });
  const three = run(["--json", "new", "Agent proposal three", ...SECTIONS, "--no-edit"], {
    ...agent,
    ARK_ON_BEHALF_OF: "demo",
  });
  expect(three.status).toBe(2);
  expect(JSON.parse(three.stdout).error.code).toBe("config");

  // list, verify, then a tamper verify reports
  const listed = json(["list"]);
  type Listed = { title: string; status: string; number: number | null; proposed_at: string };
  const decisions: Listed[] = listed.decisions;
  // Proposals made in the same second are ordered by their random ids, so compare as a set and
  // check the documented order (proposed_at, then id) separately.
  expect(decisions.map((d) => [d.title, d.status]).sort()).toEqual(
    [
      ["Use DynamoDB for orders", "superseded"],
      ["Use Aurora for orders", "superseded"],
      ["Use Postgres for orders", "deprecated"],
      ["Adopt GraphQL federation", "rejected"],
      ["Cache order reads", "withdrawn"],
      ["Agent proposal one", "proposed"],
      ["Agent proposal two", "proposed"],
    ].sort(),
  );
  const times = decisions.filter((d) => d.number === null).map((d) => d.proposed_at);
  expect(times).toEqual([...times].sort());
  expect(ok(["verify"]).stdout).toBe("No findings.\n");
  const body = join(r.root, `docs/adr/decisions/${c}-use-postgres-for-orders.md`);
  await appendFile(body, "tampered\n");
  expect(run(["verify"]).status).toBe(1);

  // every commit adr made has a Conventional subject
  const subjects = (await git(r, "log", "--format=%s")).trim().split("\n");
  const own = subjects.filter((s) => !/^(initial|refactor: move)/i.test(s));
  for (const s of own) expect(s).toMatch(/^[a-z]+(\([a-z]+\))?: [^A-Z]/);
});
