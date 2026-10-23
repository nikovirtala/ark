import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { cliRepo, NYGARD_SECTIONS, runAdr, seedDecision, WRITE_KEYS } from "../test-support/cli.js";

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
