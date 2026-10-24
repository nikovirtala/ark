import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { openDecisionLog } from "../log.js";
import { INDEX_AFTER, INDEX_RERUN } from "../log-index.js";
import {
  cliRepo,
  failingPreCommit,
  hintCommand,
  NYGARD_SECTIONS,
  REPO_HUMAN,
  runAdr,
  runShell,
  seedDecision,
  WRITE_KEYS,
} from "../test-support/cli.js";
import { freshIndex, INDEX, INDEX_CONFIG, indexCopies } from "../test-support/index-repo.js";
import { proposeDecision, WRITE_RERUN } from "../write.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(...args: Parameters<typeof cliRepo>): Promise<TempRepo> {
  const r = await cliRepo(...args);
  repos.push(r);
  return r;
}
async function git(r: TempRepo, ...args: string[]): Promise<string> {
  return Buffer.from((await r.git.run(args)).stdout).toString("utf8");
}
/** The exit status of a git command, for `git diff --quiet`. */
async function gitStatus(r: TempRepo, ...args: string[]): Promise<number> {
  return (await r.git.run(args, { okCodes: [0, 1] })).code;
}
const head = async (r: TempRepo) => (await git(r, "rev-parse", "HEAD")).trim();
const staged = async (r: TempRepo) =>
  (await git(r, "diff", "--cached", "--name-only")).split("\n").filter((l) => l !== "");

const sectionArgs = (sections: Readonly<Record<string, string>>) =>
  Object.entries(sections).flatMap(([k, v]) => ["--section", `${k}=${v}`]);
const FULL = sectionArgs(NYGARD_SECTIONS);
const { consequences: _, ...BUT_CONSEQUENCES } = NYGARD_SECTIONS;
const PARTIAL = sectionArgs(BUT_CONSEQUENCES);
const GUIDANCE = "What becomes easier or harder because of this change? Include the risks.";

/** An executable editor script in the repo's git directory (never part of the work tree). */
async function editor(r: TempRepo, body: string): Promise<NodeJS.ProcessEnv> {
  const path = join(r.root, ".git", "editor.sh");
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return { EDITOR: path };
}

type View = {
  id: string;
  body_path: string;
  status: string;
  number: number | null;
  display: string;
};
type WriteDoc = {
  ok: boolean;
  decision: View | null;
  affected: View[];
  written: string[];
  commit: string | null;
  findings: { rule: string; message: string; file: string | null }[];
  notes: string[];
};
const json = (stdout: string) => JSON.parse(stdout) as WriteDoc;

describe("adr new", { timeout: 60_000 }, () => {
  it("writes and stages a draft, and says what to fill in", async () => {
    const r = await repo();
    const out = runAdr(r, ["new", "Use Aurora for orders", ...PARTIAL]);
    expect(out.status).toBe(0);
    const lines = out.stdout.trimEnd().split("\n");
    const id = /^Proposed (\S+): Use Aurora for orders$/.exec(lines[0] ?? "")?.[1] ?? "";
    expect(out.stderr).toBe(
      `adr: warning: docs/adr/decisions/${id}-use-aurora-for-orders.md: fill in 1 required section before committing or accepting: Consequences (guidance text left); adr verify reports this until then\n`,
    );
    expect(lines.slice(1, 4)).toEqual([
      `  docs/adr/decisions/${id}-use-aurora-for-orders.md`,
      "  docs/adr/templates/nygard.md",
      expect.stringMatching(new RegExp(`^ {2}docs/adr/events/${id}/\\S+-proposed\\.yaml$`)),
    ]);
    expect(lines.slice(4)).toEqual([
      "Fill in 1 section before accepting: Consequences (guidance text left)",
      `Next: adr accept ${id}`,
    ]);
    expect((await staged(r)).sort()).toEqual([...lines.slice(1, 4).map((l) => l.trim())].sort());
    const none = runAdr(r, ["new", "Use DynamoDB", "--json"]);
    expect(json(none.stdout).findings.map((f) => f.rule)).toEqual([
      "template/guidance-left",
      "template/guidance-left",
      "template/guidance-left",
      "template/guidance-left",
    ]);
    expect(runAdr(r, ["new", "Use DynamoDB"]).stdout).toContain(
      "Fill in 4 sections before accepting: Context, Decision, Scope, Consequences (guidance text left)\n",
    );
  });

  it("refuses --no-edit --commit with unfilled sections and writes nothing", async () => {
    const r = await repo();
    const before = await head(r);
    const out = runAdr(r, ["new", "Use Aurora for orders", ...PARTIAL, "--no-edit", "--commit"]);
    expect(out.status).toBe(1);
    const lines = out.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("Not proposed: Use Aurora for orders");
    expect(lines[1]).toMatch(
      /^ {2}docs\/adr\/decisions\/\S+-use-aurora-for-orders\.md: section Consequences still contains its guidance text \[template\/guidance-left\]$/,
    );
    expect(lines.slice(2)).toEqual([
      "Fill them in with --section <id>=<markdown>, or run without --commit and edit the draft.",
    ]);
    expect(out.stderr).toBe("");
    expect(await git(r, "status", "--porcelain")).toBe("");
    expect(await head(r)).toBe(before);
    const doc = json(
      runAdr(r, ["new", "Use Aurora for orders", ...PARTIAL, "--no-edit", "--commit", "--json"])
        .stdout,
    );
    expect(doc).toMatchObject({ ok: false, decision: null, written: [], commit: null });
    expect(doc.findings.map((f) => f.rule)).toEqual(["template/guidance-left"]);
  });

  it("commits with --commit, or with auto_commit unless --no-commit", async () => {
    const r = await repo({ "docs/adr/adr.toml": "[policy]\nauto_commit = true\n" });
    const before = await head(r);
    const auto = json(runAdr(r, ["new", "First", ...FULL, "--json"]).stdout);
    expect(auto.commit).not.toBeNull();
    expect(await head(r)).toBe(auto.commit);
    const staged_ = runAdr(r, ["new", "Second", ...FULL, "--no-commit"]);
    expect(staged_.status).toBe(0);
    expect(staged_.stdout).not.toContain("Committed");
    expect(await head(r)).toBe(auto.commit);
    expect(before).not.toBe(auto.commit);
  });

  it("exits 2 for bad arguments and writes nothing", async () => {
    const r = await repo();
    const cases: [string[], string][] = [
      [["new", "T", "--section", "context"], '--section needs <id>=<markdown>, not "context"'],
      [["new", "T", "--section", "=x"], '--section needs <id>=<markdown>, not "=x"'],
      [
        ["new", "T", "--section", "context=a", "--section", "context=b"],
        "--section context is given twice",
      ],
      [
        ["new", "T", "--section", "nope=x"],
        "template nygard has no section nope; its sections are context, decision, scope, consequences",
      ],
      [["new", "T", "--template", "team"], "unknown template team;"],
      [["new", "  "], "the title must be a single line of 1 to 200 characters"],
      [["new", "T", "--supersedes", "ADR-0042"], "unknown decision ADR-0042"],
      [["new"], "missing argument <title>"],
      [["new", "T", "--ref", "HEAD"], "new does not take --ref; it works on the work tree"],
    ];
    for (const [args, message] of cases) {
      const out = runAdr(r, args);
      expect(out.status, args.join(" ")).toBe(2);
      expect(out.stderr).toContain(`adr: error: ${message}`);
    }
    expect(await staged(r)).toEqual([]);
    expect(await git(r, "status", "--porcelain")).toBe("");
  });
});

describe("adr accept and supersede", { timeout: 60_000 }, () => {
  it("accepts with --commit, numbering the decision on main", async () => {
    const r = await repo();
    const id = json(runAdr(r, ["new", "Use Aurora for orders", ...FULL, "--json"]).stdout).decision
      ?.id;
    const out = runAdr(r, ["accept", id ?? "", "--commit"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe(
      `Accepted ${id}: Use Aurora for orders\nCommitted ${(await head(r)).slice(0, 7)} as ADR-0001.\n`,
    );
  });

  it("reports the number with --json after --commit on main, and none without a commit", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Use DynamoDB for orders", { accept: false, commit: false });
    const staged_ = json(runAdr(r, ["accept", a, "--json"]).stdout);
    expect(staged_).toMatchObject({ ok: true, commit: null });
    expect(staged_.decision).toMatchObject({ id: a, number: null, display: a });

    const b = await seedDecision(r, "Use Aurora for orders", { accept: false, commit: false });
    const accepted = json(runAdr(r, ["accept", b, "--commit", "--json"]).stdout);
    expect(accepted.commit).toBe(await head(r));
    expect(accepted.decision).toMatchObject({ id: b, number: 1, display: "ADR-0001" });

    const c = await seedDecision(r, "Use Postgres for orders");
    const out = runAdr(r, ["supersede", b, "--by", c, "--commit", "--json"]);
    expect(out.status).toBe(0);
    const superseded = json(out.stdout);
    expect(superseded.commit).toBe(await head(r));
    expect(superseded.decision).toMatchObject({
      id: b,
      status: "superseded",
      number: 1,
      display: "ADR-0001",
    });
    expect(superseded.affected).toEqual([
      expect.objectContaining({ id: b, status: "superseded", number: 1, display: "ADR-0001" }),
    ]);
  });

  it("stages without --commit, and names the number's arrival on a branch", async () => {
    const r = await repo();
    await r.checkout("topic", { create: true });
    const a = await seedDecision(r, "Use DynamoDB for orders", { accept: false, commit: false });
    expect(runAdr(r, ["accept", a]).stdout).toBe(
      `Accepted ${a}: Use DynamoDB for orders\nStaged; commit to record it.\n`,
    );
    const b = await seedDecision(r, "Use Aurora for orders", { accept: false, commit: false });
    const out = runAdr(r, ["accept", b, "--commit"]);
    expect(out.stdout).toBe(
      `Accepted ${b}: Use Aurora for orders\nCommitted ${(await head(r)).slice(0, 7)}. The number is assigned when this commit lands on main.\n`,
    );
  });

  it("exits 1 when the log forbids the write, with the findings", async () => {
    const r = await repo();
    const draft = json(runAdr(r, ["new", "Draft", "--json"]).stdout).decision?.id ?? "";
    const unfilled = runAdr(r, ["accept", draft]);
    expect(unfilled.status).toBe(1);
    expect(unfilled.stdout).toMatch(
      new RegExp(
        `^Not accepted: ${draft}: Draft\n {2}docs/adr/decisions/${draft}-draft\\.md: section Context still contains its guidance text \\[template/guidance-left\\]\n`,
      ),
    );
    const doc = json(runAdr(r, ["accept", draft, "--json"]).stdout);
    expect(doc).toMatchObject({ ok: false, written: [], commit: null });

    const a = await seedDecision(r, "Use DynamoDB for orders");
    const again = runAdr(r, ["accept", a, "--json"]);
    expect(again.status).toBe(1);
    expect(json(again.stdout).findings).toEqual([
      expect.objectContaining({
        rule: "transition/illegal",
        message: "accepted is not allowed while accepted",
      }),
    ]);

    const proposed = await seedDecision(r, "Proposal", { accept: false });
    const byUnaccepted = runAdr(r, ["supersede", a, "--by", proposed, "--json"]);
    expect(byUnaccepted.status).toBe(1);
    expect(json(byUnaccepted.stdout).findings.map((f) => f.rule)).toEqual([
      "decision/superseded-by-unaccepted",
    ]);
    const notAccepted = runAdr(r, ["supersede", proposed, "--by", a]);
    expect(notAccepted.status).toBe(1);
    expect(notAccepted.stdout).toContain(
      "superseded is not allowed while proposed [transition/illegal]",
    );
  });

  it("tells an agent to ask a human to accept, unless agents may accept", async () => {
    const r = await repo();
    const env = { ARK_AGENT: "test-agent", ARK_ON_BEHALF_OF: "niko@example.com" };
    const agent = runAdr(r, ["new", "Agent draft", ...FULL], { env });
    expect(agent.status).toBe(0);
    const id = /^Proposed (\S+):/.exec(agent.stdout)?.[1] ?? "";
    expect(agent.stdout.trimEnd().split("\n").at(-1)).toBe(
      `Next: ask a human to review and accept it (adr accept ${id})`,
    );
    const human = runAdr(r, ["new", "Human draft", ...FULL]);
    const hid = /^Proposed (\S+):/.exec(human.stdout)?.[1] ?? "";
    expect(human.stdout.trimEnd().split("\n").at(-1)).toBe(`Next: adr accept ${hid}`);
    const asJson = json(runAdr(r, ["new", "Agent JSON", ...FULL, "--json"], { env }).stdout);
    expect(Object.keys(asJson).sort()).toEqual(WRITE_KEYS);

    const lax = await repo({ "docs/adr/adr.toml": "[policy]\naccept_requires_human = false\n" });
    const allowed = runAdr(lax, ["new", "Agent draft", ...FULL], { env });
    const aid = /^Proposed (\S+):/.exec(allowed.stdout)?.[1] ?? "";
    expect(allowed.stdout.trimEnd().split("\n").at(-1)).toBe(`Next: adr accept ${aid}`);
  });

  it("refuses an agent's acceptance under accept_requires_human", async () => {
    const r = await repo();
    const env = { ARK_AGENT: "test-agent" };
    const created = json(runAdr(r, ["new", "Agent draft", ...FULL, "--json"], { env }).stdout);
    expect(created.ok).toBe(true);
    const out = runAdr(r, ["accept", created.decision?.id ?? "", "--json"], { env });
    expect(out.status).toBe(1);
    expect(json(out.stdout).findings).toEqual([
      expect.objectContaining({
        rule: "decision/agent-accepted",
        message: "accepted by agent test-agent; accept_requires_human needs a human",
      }),
    ]);
    const bad = runAdr(r, ["new", "T"], { env: { ARK_AGENT: "-x" } });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('adr: error: ARK_AGENT "-x" must match');
  });

  it("supersedes with --by, and exits 2 for bad usage", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Use DynamoDB for orders");
    const b = await seedDecision(r, "Use Aurora for orders");
    expect(runAdr(r, ["accept", a, "--ref", "HEAD"])).toEqual({
      status: 2,
      stdout: "",
      stderr: "adr: error: accept does not take --ref; it works on the work tree\n",
    });
    const missing = runAdr(r, ["supersede", a]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toBe(
      "adr: error: missing --by <decision>; usage: adr supersede <decision> --by <decision> [--reason <text>] [--commit | --no-commit] [-m <message>]\n",
    );
    expect(runAdr(r, ["supersede", a, "--by", "x:ADR-0001"]).stderr).toBe(
      "adr: error: --by x:ADR-0001: cross-log supersession isn't supported yet\n",
    );
    expect(runAdr(r, ["supersede", a, "--by", "ADR-0042"]).stderr).toBe(
      "adr: error: unknown decision ADR-0042\n",
    );
    const out = runAdr(r, ["supersede", "ADR-0001", "--by", "ADR-0002", "--reason", "Faster"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe(
      `Superseded ADR-0001 (${a}): Use DynamoDB for orders\n  by ADR-0002 (${b})\nStaged; commit to record it.\n`,
    );
  });
});

describe("--commit messages", { timeout: 60_000 }, () => {
  const body = (r: TempRepo) => git(r, "log", "-1", "--format=%B");
  const LONG =
    "Use event sourcing with one append-only log per subject for every record kind in the monorepo";

  it("writes conventional subjects, bodies and the trailers last", async () => {
    const r = await repo();
    const created = runAdr(r, ["new", "Use DynamoDB for orders", ...FULL, "--commit", "--json"]);
    expect(created.status).toBe(0);
    const a = json(created.stdout).decision?.id ?? "";
    expect(await body(r)).toBe(
      `docs(adr): propose to use DynamoDB for orders\n\nADR: ${a}\nADR-Event: proposed\n\n`,
    );
    expect(runAdr(r, ["accept", a, "--commit"]).status).toBe(0);
    expect(await body(r)).toBe(
      `docs(adr): decide to use DynamoDB for orders\n\nADR: ${a}\nADR-Event: accepted\n\n`,
    );
    // A title ending in "." gets one period in the body sentence.
    const b = await seedDecision(r, "Use Aurora for orders.");
    expect(runAdr(r, ["supersede", a, "--by", b, "--commit"]).status).toBe(0);
    expect(await body(r)).toBe(
      [
        "docs(adr): supersede ADR-0001 with ADR-0002",
        "",
        "Superseded by ADR-0002: Use Aurora for orders.",
        "",
        `ADR: ${a}`,
        "ADR-Event: superseded",
        "",
        "",
      ].join("\n"),
    );
  });

  it("shortens a long title, keeps it in the body and says so", async () => {
    const r = await repo();
    const id = await seedDecision(r, LONG, { accept: false });
    const out = runAdr(r, ["accept", id, "--commit", "--json"]);
    expect(out.status).toBe(0);
    expect(await body(r)).toBe(
      [
        "docs(adr): decide to use event sourcing with one append-only log per subject for…",
        "",
        "Full title: Use event sourcing with one append-only log per subject for",
        "every record kind in the monorepo",
        "",
        `ADR: ${id}`,
        "ADR-Event: accepted",
        "",
        "",
      ].join("\n"),
    );
    const note = "commit subject shortened to 72 characters; the full title is in the commit body";
    expect(json(out.stdout).notes).toEqual([note]);
    expect(out.stderr).toBe(`adr: warning: ${note}\n`);
  });

  it("keeps the natural casing of the title after its first letter", async () => {
    const r = await repo();
    const out = runAdr(r, ["new", "Use the CLI with ARK_AGENT on Node 24.", ...FULL, "--commit"]);
    expect(out.status).toBe(0);
    expect(await git(r, "log", "-1", "--format=%s")).toBe(
      "docs(adr): propose to use the CLI with ARK_AGENT on Node 24\n",
    );
  });

  it("commits -m as given, with the trailers as its last paragraph", async () => {
    const r = await repo();
    const out = runAdr(r, [
      "new",
      "Use Aurora for orders",
      ...FULL,
      "--commit",
      "-m",
      "chore: Record the Aurora proposal\n\nThe team agreed on it.",
      "--json",
    ]);
    expect(out.status).toBe(0);
    const id = json(out.stdout).decision?.id ?? "";
    expect(await body(r)).toBe(
      `chore: Record the Aurora proposal\n\nThe team agreed on it.\n\nADR: ${id}\nADR-Event: proposed\n\n`,
    );
    expect(json(out.stdout).notes).toEqual([]);
  });

  it("appends the trailers to a -m message's own trailer block", async () => {
    const r = await repo();
    const out = runAdr(r, [
      "new",
      "Use Aurora for orders",
      ...FULL,
      "--commit",
      "-m",
      "chore: record it\n\nCo-authored-by: A <a@x>\nRefs: #12",
      "--json",
    ]);
    expect(out.status).toBe(0);
    const id = json(out.stdout).decision?.id ?? "";
    expect(await body(r)).toBe(
      `chore: record it\n\nCo-authored-by: A <a@x>\nRefs: #12\nADR: ${id}\nADR-Event: proposed\n\n`,
    );
  });

  it("appends the trailers to a -m block git reads as trailers, and only to those", async () => {
    const r = await repo();
    const cases = [
      ["chore: record it\n\nSigned-off-by: A <a@x>\nwe paired on this", "\n"],
      ["chore: record it\n\nSee the design doc at https://example.com/adr/42.", "\n\n"],
      ["chore: record it\n\nWe decided: use Aurora.", "\n\n"],
    ] as const;
    for (const [i, [message, gap]] of cases.entries()) {
      const out = runAdr(r, [
        "new",
        `Use Aurora ${i}`,
        ...FULL,
        "--commit",
        "-m",
        message,
        "--json",
      ]);
      expect(out.status).toBe(0);
      const id = json(out.stdout).decision?.id ?? "";
      expect(await body(r)).toBe(`${message}${gap}ADR: ${id}\nADR-Event: proposed\n\n`);
    }
  });

  it("keeps a mixed-case first word of the title as written", async () => {
    const r = await repo();
    const out = runAdr(r, ["new", "GraphQL federation for the public API", ...FULL, "--commit"]);
    expect(out.status).toBe(0);
    expect(await git(r, "log", "-1", "--format=%s")).toBe(
      "docs(adr): propose to GraphQL federation for the public API\n",
    );
  });

  it("refuses a [commit] subject that could cut a supersede subject's names", async () => {
    const subject = (fixed: number) =>
      `[commit]\nsubject = "docs(adr): ${"x".repeat(fixed - 1)} {title}"\n`;
    const r = await repo({ "docs/adr/adr.toml": subject(52) });
    const bad = runAdr(r, ["new", "Use Aurora", ...FULL, "--commit"]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("adr: error: docs/adr/adr.toml: commit.subject leaves no room");

    await writeFile(join(r.root, "docs/adr/adr.toml"), subject(30));
    for (const title of ["Use DynamoDB", "Use Aurora"]) {
      const created = runAdr(r, ["new", title, ...FULL, "--commit", "--json"]);
      expect(created.status).toBe(0);
      expect(
        runAdr(r, ["accept", json(created.stdout).decision?.id ?? "", "--commit"]).status,
      ).toBe(0);
    }
    const out = runAdr(r, ["supersede", "ADR-0001", "--by", "ADR-0002", "--commit", "--json"]);
    expect(out.status).toBe(0);
    expect(await git(r, "log", "-1", "--format=%s")).toBe(
      `docs(adr): ${"x".repeat(29)} ADR-0001 with ADR-0002\n`,
    );
    expect(await body(r)).not.toContain("Full title:");
    expect(json(out.stdout).notes).toEqual([]);
  });

  it("uses [commit] subject from adr.toml, and exits 2 for an invalid one", async () => {
    const r = await repo({
      "docs/adr/adr.toml": '[commit]\nsubject = "docs({command}): {action} {raw_title}"\n',
    });
    expect(runAdr(r, ["new", "Use Aurora", ...FULL, "--commit"]).status).toBe(0);
    expect(await git(r, "log", "-1", "--format=%s")).toBe("docs(new): propose to Use Aurora\n");

    await writeFile(
      join(r.root, "docs/adr/adr.toml"),
      '[commit]\nsubject = "docs(adr): {verb} {title}"\n',
    );
    const before = await git(r, "status", "--porcelain");
    const bad = runAdr(r, ["--json", "new", "Use DynamoDB", ...FULL, "--commit"]);
    expect(bad.status).toBe(2);
    expect(JSON.parse(bad.stdout)).toMatchObject({
      format: "ark-error/v1",
      error: { code: "config" },
    });
    expect(bad.stderr).toContain(
      "adr: error: docs/adr/adr.toml: commit.subject uses unknown placeholder {verb}",
    );
    expect(await git(r, "status", "--porcelain")).toBe(before);
  });

  it("exits 2 for -m without a commit, and for --commit without a committer", async () => {
    const r = await repo();
    const cases: [string[], NodeJS.ProcessEnv, string][] = [
      [
        ["new", "T", ...FULL, "-m", "x"],
        {},
        "--message needs --commit (or [policy] auto_commit = true)",
      ],
      [
        ["new", "T", ...FULL, "--no-commit", "-m", "x"],
        {},
        "--message can't be used with --no-commit",
      ],
      [["new", "T", ...FULL, "--commit", "-m", "  "], {}, "the commit message is empty"],
      [
        ["new", "T", ...FULL, "--commit"],
        { GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined },
        "--commit needs a git identity; set git user.name and user.email",
      ],
    ];
    for (const [args, env, message] of cases) {
      const out = runAdr(r, args, { env });
      expect(out.status, args.join(" ")).toBe(2);
      expect(out.stderr).toBe(`adr: error: ${message}\n`);
    }
    expect(await git(r, "status", "--porcelain")).toBe("");
    const a = await seedDecision(r, "Use Aurora", { accept: false, commit: false });
    expect(runAdr(r, ["accept", a, "-m", "x"]).status).toBe(2);
    expect(runAdr(r, ["supersede", a, "--by", a, "--no-commit", "-m", "x"]).status).toBe(2);
  });
});

// AC 19: the editor runs between staging and committing, and never commits unconfirmed content.
describe("adr new --edit", { timeout: 60_000 }, () => {
  const FILL = `f="$1"; grep -v '${GUIDANCE}' "$f" > "$f.tmp" && mv "$f.tmp" "$f"; echo "Ops get one more service." >> "$f"`;

  it("stages but doesn't commit when the edited draft still has unfilled sections", async () => {
    const r = await repo();
    const before = await head(r);
    const env = await editor(r, "exit 0");
    const out = runAdr(r, ["new", "Unfilled", ...PARTIAL, "--edit", "--commit", "--json"], { env });
    expect(out.status).toBe(0);
    const doc = json(out.stdout);
    const body = doc.findings[0]?.file ?? "";
    expect(doc).toMatchObject({ ok: true, commit: null });
    expect(out.stderr).toBe(
      [
        `adr: warning: not committed: ${body} still has unfilled required sections; fill them in, then commit`,
        `adr: warning: ${body}: fill in 1 required section before committing or accepting: Consequences (guidance text left); adr verify reports this until then`,
        "",
      ].join("\n"),
    );
    expect(await head(r)).toBe(before);
    expect(await staged(r)).toContain(body);
  });

  it("commits the edited body with --commit, and lints the edit", async () => {
    const r = await repo();
    const env = await editor(r, FILL);
    const out = runAdr(r, ["new", "Use Aurora for orders", ...PARTIAL, "--edit", "--commit"], {
      env,
    });
    expect(out.status).toBe(0);
    expect(out.stderr).toBe("");
    expect(out.stdout).not.toContain("Fill in");
    const body = (await git(r, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"))
      .split("\n")
      .find((p) => p.startsWith("docs/adr/decisions/"));
    expect(await git(r, "show", `HEAD:${body}`)).toMatch(
      /## Consequences\nOps get one more service\.\n$/,
    );
    expect(await gitStatus(r, "diff", "--quiet", "--", body ?? "")).toBe(0);
    expect(await gitStatus(r, "diff", "--cached", "--quiet", "--", body ?? "")).toBe(0);

    const doc = json(
      runAdr(r, ["new", "Use DynamoDB", ...PARTIAL, "--edit", "--commit", "--json"], { env })
        .stdout,
    );
    expect(doc.findings).toEqual([]);
    const unedited = json(runAdr(r, ["new", "Unedited", ...PARTIAL, "--json"]).stdout);
    expect(unedited.findings.map((f) => f.rule)).toEqual(["template/guidance-left"]);
  });

  it("stages the edited body without --commit", async () => {
    const r = await repo();
    const env = await editor(r, 'echo "An appended line." >> "$1"');
    const doc = json(runAdr(r, ["new", "Use Aurora", ...FULL, "--edit", "--json"], { env }).stdout);
    const body = doc.decision?.body_path ?? "";
    expect(doc.commit).toBeNull();
    expect(await git(r, "diff", "--cached", "--", body)).toContain("+An appended line.");
    expect(await git(r, "diff", "--", body)).toBe("");
  });

  it("keeps the render when the editor fails without changing it, and still commits", async () => {
    const r = await repo();
    const env = await editor(r, "exit 1");
    const out = runAdr(r, ["new", "Use Aurora", ...FULL, "--edit", "--json"], { env });
    expect(out.status).toBe(0);
    expect(out.stderr).toBe(
      "adr: warning: the editor exited with status 1; the draft is staged as rendered\n",
    );
    const body = json(out.stdout).decision?.body_path ?? "";
    expect(await git(r, "show", `:${body}`)).toContain("## Consequences\nOne more service to run.");
    expect(await gitStatus(r, "diff", "--quiet", "--", body)).toBe(0);

    const committed = json(
      runAdr(r, ["new", "Use DynamoDB", ...FULL, "--edit", "--commit", "--json"], { env }).stdout,
    );
    expect(committed.commit).not.toBeNull();
    expect(await head(r)).toBe(committed.commit);
  });

  it("doesn't commit when the editor changed the body and failed", async () => {
    const r = await repo();
    const before = await head(r);
    const env = await editor(r, 'echo "half an edit" >> "$1"; exit 1');
    const out = runAdr(r, ["new", "Use Aurora", ...FULL, "--edit", "--commit", "--json"], { env });
    expect(out.status).toBe(0);
    const doc = json(out.stdout);
    const body = doc.decision?.body_path ?? "";
    expect(doc.commit).toBeNull();
    expect(out.stderr).toBe(
      [
        "adr: warning: the editor exited with status 1; the draft is staged as rendered",
        `adr: warning: not committed: ${body} changed while the editor failed; review it, then git add it and commit`,
        "",
      ].join("\n"),
    );
    expect(await head(r)).toBe(before);
    expect(await readFile(join(r.root, body), "utf8")).toMatch(/half an edit\n$/);
    expect(await git(r, "show", `:${body}`)).not.toContain("half an edit");
  });

  it("notes a removed body, and a missing editor", async () => {
    const r = await repo();
    const env = await editor(r, 'rm "$1"');
    const out = runAdr(r, ["new", "Use Aurora", ...FULL, "--edit", "--commit", "--json"], { env });
    expect(out.status).toBe(0);
    const body = json(out.stdout).decision?.body_path ?? "";
    expect(out.stderr).toBe(
      `adr: warning: not committed: ${body} was removed while editing; the rendered draft is still staged. Restore it with \`git checkout -- ${body}\`\n`,
    );
    const none = runAdr(r, ["new", "No editor", ...FULL, "--edit"]);
    expect(none.status).toBe(0);
    expect(none.stderr).toBe("adr: warning: no editor: set VISUAL or EDITOR\n");
  });
});

// Design 2b D5: a failed `git commit` during --commit leaves the batch staged with a manual command.
describe("a commit git refuses", { timeout: 60_000 }, () => {
  it("prints the hint for accept --commit, and its command makes the commit", async () => {
    const r = await repo();
    const id = await seedDecision(r, "Use Aurora", { accept: false });
    const hook = await failingPreCommit(r);
    const before = await head(r);
    const out = runAdr(r, ["accept", id, "--commit"]);
    expect(out.status).toBe(2);
    expect(out.stdout).toBe("");
    const lines = out.stderr.split("\n");
    expect(lines.slice(0, 2)).toEqual([
      "adr: error: git commit failed (exit 1): hook says no",
      "  hook says no",
    ]);
    expect(out.stderr).toContain(`The files are written and staged. ${WRITE_RERUN} Staged for`);
    const body = `docs/adr/decisions/${id}-use-aurora.md`;
    const event = (await staged(r)).find((p) => p.endsWith("-accepted.yaml")) ?? "";
    expect(event).toMatch(new RegExp(`^docs/adr/events/${id}/\\S+-accepted\\.yaml$`));
    expect(lines).toContain(`  ${body}`);
    expect(lines).toContain(`  ${event}`);
    expect(lines.slice(-3)).toEqual([`  ADR: ${id}`, "  ADR-Event: accepted", ""]);
    expect(await head(r)).toBe(before);

    await rm(hook);
    const command = hintCommand(out.stderr);
    expect(command).toContain(`--only -- ${body} ${event}`);
    expect(runShell(r, command).status).toBe(0);
    expect(await head(r)).not.toBe(before);
    // The body is listed but unchanged by accept, so the commit adds the event only.
    expect(await git(r, "show", "--name-only", "--format=", "HEAD")).toBe(`${event}\n`);
    expect(await git(r, "log", "-1", "--format=%(trailers:only,unfold)")).toBe(
      `ADR: ${id}\nADR-Event: accepted\n\n`,
    );
    expect(runAdr(r, ["verify"]).status).toBe(0);
    expect(await git(r, "status", "--porcelain")).toBe("");
  });

  it("gives new --commit the same rerun sentence, and --json a commit-failed error", async () => {
    const r = await repo();
    await failingPreCommit(r);
    const out = runAdr(r, ["new", "Use Aurora", ...FULL, "--no-edit", "--commit"]);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain(WRITE_RERUN);
    expect(out.stderr).toContain("  ADR-Event: proposed\n");

    const doc = runAdr(r, ["new", "Use DynamoDB", ...FULL, "--no-edit", "--commit", "--json"]);
    expect(doc.status).toBe(2);
    const error = JSON.parse(doc.stdout) as {
      format: string;
      error: { code: string; message: string };
    };
    expect(error.format).toBe("ark-error/v1");
    expect(error.error.code).toBe("commit-failed");
    expect(error.error.message).toContain(WRITE_RERUN);
  });
});

// A refused commit keeps the write's notes: they come before the hint, and in --json's notes.
describe("a write whose commit git refuses", { timeout: 60_000 }, () => {
  it("prints the write's notes as warnings before the hint", async () => {
    const r = await repo();
    const x = await seedDecision(r, "Use Aurora", { accept: false });
    await failingPreCommit(r);
    const env = { ARK_ON_BEHALF_OF: "niko@example.org" };
    const args = ["scope", x, "--set", "nothing/**", "--commit"];
    const ignored =
      "ARK_ON_BEHALF_OF is ignored without ARK_AGENT; events are recorded as Ledger Test <ledger-test@example.com>";
    const out = runAdr(r, args, { env });
    expect(out.status).toBe(2);
    const lines = out.stderr.split("\n");
    expect(lines[0]).toBe(`adr: warning: ${ignored}`);
    expect(lines[1]).toMatch(/^adr: warning: nothing\/\*\* matches no tracked file/);
    expect(lines[2]).toMatch(/^adr: error: git commit failed \(exit 1\): hook says no$/);
    expect(out.stderr).toContain(WRITE_RERUN);

    const json = runAdr(r, ["--json", "note", x, "A note.", "--commit"], { env });
    expect(json.status).toBe(2);
    const doc = JSON.parse(json.stdout) as { error: { code: string }; notes: string[] };
    expect(doc.error.code).toBe("commit-failed");
    expect(doc.notes).toEqual([ignored]);
  });
});

// Design 2b §4.5 and D5 with [log] index = "committed".
describe("writes with a committed index", { timeout: 60_000 }, () => {
  /** A log with the index on and committed, and `x` proposed and committed. */
  async function indexedRepo(): Promise<{ r: TempRepo; x: string }> {
    const r = await repo({ "docs/adr/adr.toml": INDEX_CONFIG });
    const x = await seedDecision(r, "Use Aurora", { accept: false });
    return { r, x };
  }
  const verify = (r: TempRepo, ...args: string[]) => runAdr(r, ["verify", ...args]).status;

  it("commits X's index after an uncommitted adr new X, then adr accept X --commit", async () => {
    const r = await repo({ "docs/adr/adr.toml": INDEX_CONFIG });
    const created = json(runAdr(r, ["new", "Use Aurora", ...FULL, "--no-edit", "--json"]).stdout);
    const x = created.decision?.id ?? "";
    expect(runAdr(r, ["accept", x, "--commit"]).status).toBe(0);
    const { head: index } = await indexCopies(r);
    expect(index).toBe(await freshIndex(r.git, "HEAD"));
    expect(index).toContain(`| ADR-0001 | [Use Aurora](decisions/${x}-use-aurora.md) | accepted |`);
    expect(verify(r, "--ref", "HEAD")).toBe(0);
    expect(await git(r, "status", "--porcelain")).toBe("");
  });

  for (const [name, args] of [
    ["scope", (x: string) => ["scope", x, "--set", "README.md"]],
    ["note", (x: string) => ["note", x, "A note."]],
    ["link", (x: string) => ["link", x, "ZZ"]],
  ] as const) {
    it(`commits the index with X's earlier uncommitted proposal for ${name} --commit`, async () => {
      const r = await repo({ "docs/adr/adr.toml": INDEX_CONFIG });
      const z = await seedDecision(r, "Use Redis");
      const created = json(runAdr(r, ["new", "Use Aurora", ...FULL, "--no-edit", "--json"]).stdout);
      const x = created.decision?.id ?? "";
      const out = runAdr(r, [...args(x).map((a) => (a === "ZZ" ? z : a)), "--commit"]);
      expect(out.status).toBe(0);
      const { head: index } = await indexCopies(r);
      expect(index).toBe(await freshIndex(r.git, "HEAD"));
      expect(index).toMatch(new RegExp(`## Proposed\n\n.*\n.*\n\\| ${x} \\| \\[Use Aurora\\]`));
      expect(verify(r, "--ref", "HEAD")).toBe(0);
      expect(await git(r, "status", "--porcelain")).toBe("");
    });
  }

  it("lists index.md in accept's hint and ends with INDEX_AFTER; scope's hint has neither", async () => {
    const { r, x } = await indexedRepo();
    await failingPreCommit(r);
    const out = runAdr(r, ["accept", x, "--commit"]);
    expect(out.status).toBe(2);
    expect(out.stderr.split("\n")).toContain(`  ${INDEX}`);
    expect(hintCommand(out.stderr)).toMatch(/ docs\/adr\/index\.md$/);
    expect(out.stderr).toMatch(new RegExp(`\n${escapeRegExp(INDEX_AFTER("docs/adr"))}\n$`));

    const { r: s, x: y } = await indexedRepo();
    await failingPreCommit(s);
    const scoped = runAdr(s, ["scope", y, "--set", "README.md", "--commit"]);
    expect(scoped.status).toBe(2);
    expect(scoped.stderr.split("\n")).not.toContain(`  ${INDEX}`);
    expect(scoped.stderr).not.toContain(INDEX_AFTER("docs/adr"));
  });

  it("gives a commit verify passes when the hint is followed with another decision pending", async () => {
    const { r, x } = await indexedRepo();
    const y = await seedDecision(r, "Use Redis", { accept: false, commit: false });
    const hook = await failingPreCommit(r);
    const out = runAdr(r, ["accept", x, "--commit"]);
    expect(out.status).toBe(2);
    await rm(hook);
    expect(runShell(r, hintCommand(out.stderr)).status).toBe(0);
    expect((await indexCopies(r)).head).not.toContain(y);
    expect(verify(r, "--ref", "HEAD")).toBe(0);
    expect(runAdr(r, ["index", "--no-commit"]).status).toBe(0);
    const copies = await indexCopies(r);
    expect(copies.worktree).toContain(y);
    expect(copies.staged).toBe(copies.worktree);
    expect(verify(r, "--staged")).toBe(0);
  });

  for (const how of ["rerun", "command"] as const) {
    it(`finishes a refused index --commit by ${how === "rerun" ? "running it again" : "the printed command"}`, async () => {
      const { r } = await indexedRepo();
      const text = await readFile(join(r.root, INDEX), "utf8");
      await r.write(INDEX, text.replace("[Use Aurora]", "[Use Aurora, edited]"));
      await r.commit("hand edit", { all: true });
      const hook = await failingPreCommit(r);
      const before = await head(r);
      const out = runAdr(r, ["index", "--commit"]);
      expect(out.status).toBe(2);
      expect(out.stderr).toContain(INDEX_RERUN);
      expect(out.stderr).toContain(`Staged for this commit:\n  ${INDEX}\n`);
      expect(hintCommand(out.stderr)).toMatch(/ --only -- docs\/adr\/index\.md$/);
      await rm(hook);
      if (how === "rerun") expect(runAdr(r, ["index", "--commit"]).status).toBe(0);
      else expect(runShell(r, hintCommand(out.stderr)).status).toBe(0);
      expect(await head(r)).not.toBe(before);
      expect((await indexCopies(r)).head).toBe(await freshIndex(r.git, "HEAD"));
      expect(verify(r, "--ref", "HEAD")).toBe(0);
    });
  }

  it("leaves index.md alone with index: skip, and refreshes it by default", async () => {
    const { r } = await indexedRepo();
    const log = await openDecisionLog({ cwd: r.root, gitOptions: { env: r.env } });
    const before = await indexCopies(r);
    const input = { title: "Use Redis", sections: NYGARD_SECTIONS, actor: REPO_HUMAN };
    const skipped = await proposeDecision(log, input, { index: "skip" });
    expect(skipped.written).not.toContain(INDEX);
    expect(await indexCopies(r)).toEqual(before);
    const refreshed = await proposeDecision(log, { ...input, title: "Use Kafka" });
    expect(refreshed.written).toContain(INDEX);
    expect((await indexCopies(r)).worktree).toBe(await freshIndex(r.git, "worktree"));
  });
});

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
