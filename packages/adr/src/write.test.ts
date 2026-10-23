import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Actor,
  EventExistsError,
  firstParentHistory,
  InvalidArgumentError,
  lintDocument,
  parseTemplate,
  type Trailer,
  UsageError,
} from "@nikovirtala/ledger";
import { createTempRepo, type TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { openDecisionLog, readDecisions } from "./log.js";
import { BUILTIN_TEMPLATES } from "./templates/builtin.js";
import { TEST_AGENT } from "./test-support/decision-arbs.js";
import { decisionEvent, eventFile, proposedData } from "./test-support/events.js";
import { verifyDecisions } from "./verify.js";
import {
  acceptDecision,
  applyPlan,
  followScopeRenames,
  type ProposeInput,
  proposeDecision,
  scopeDecision,
  supersedeDecision,
  type WriteDeps,
  type WriteResultJson,
} from "./write.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});

async function repo(files: Record<string, string> = {}): Promise<TempRepo> {
  const r = await createTempRepo({
    files: { "README.md": "readme\n", ".gitignore": ".DS_Store\n", ...files },
  });
  repos.push(r);
  return r;
}

const HUMAN: Actor = {
  kind: "human",
  name: "Ledger Test",
  email: "ledger-test@example.com",
  agent: null,
  on_behalf_of: null,
};
const SECTIONS = {
  context: "We need SQL.",
  decision: "We will use Aurora.",
  scope: "src/orders/**",
  consequences: "One more service to run.",
};
const TEMPLATE = "docs/adr/templates/nygard.md";

const open = (r: TempRepo) => openDecisionLog({ cwd: r.root, gitOptions: { env: r.env } });
async function git(r: TempRepo, ...args: string[]): Promise<string> {
  return Buffer.from((await r.git.run(args)).stdout).toString("utf8");
}
const lines = async (r: TempRepo, ...args: string[]) =>
  (await git(r, ...args)).split("\n").filter((l) => l !== "");
const staged = (r: TempRepo) => lines(r, "diff", "--cached", "--name-only");
const porcelain = (r: TempRepo) => git(r, "status", "--porcelain", "--untracked-files=all");
const committed = (r: TempRepo) =>
  lines(r, "diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "HEAD");
const headTrailers = async (r: TempRepo): Promise<readonly Trailer[]> =>
  (await firstParentHistory(r.git, "HEAD"))[0]?.trailers ?? [];

async function propose(
  r: TempRepo,
  title: string,
  o: Partial<ProposeInput> & { commit?: boolean } = {},
): Promise<WriteResultJson> {
  const { commit, ...input } = o;
  return proposeDecision(
    await open(r),
    { title, sections: SECTIONS, actor: HUMAN, ...input },
    commit === undefined ? {} : { commit },
  );
}
const accept = async (r: TempRepo, id: string, o: { commit?: boolean; actor?: Actor } = {}) =>
  acceptDecision(
    await open(r),
    { id, actor: o.actor ?? HUMAN },
    o.commit === undefined ? {} : { commit: o.commit },
  );
const idOf = (w: WriteResultJson) => w.decision?.id ?? "";
const pairs = (id: string, type: string): Trailer[] => [
  ["ADR", id],
  ["ADR-Event", type],
];
const verifyHead = async (r: TempRepo) =>
  verifyDecisions(await open(r), { type: "full", head: "HEAD" });

describe("proposeDecision", () => {
  it("refuses to commit a draft with unfilled sections when no editor runs", async () => {
    const r = await repo();
    const head = await r.git.resolveCommit("HEAD");
    const before = await porcelain(r);
    const w = await propose(r, "Unfilled", { sections: { context: "Why." }, commit: true });
    expect(w).toMatchObject({ ok: false, decision: null, written: [], commit: null });
    expect(w.findings.map((f) => f.rule)).toEqual([
      "template/guidance-left",
      "template/guidance-left",
      "template/guidance-left",
    ]);
    expect(w.findings[0]?.file).toMatch(/^docs\/adr\/decisions\/\S+-unfilled\.md$/);
    expect(await porcelain(r)).toBe(before);
    expect(await r.git.resolveCommit("HEAD")).toBe(head);
    const staged = await propose(r, "Unfilled", { sections: { context: "Why." } });
    expect(staged).toMatchObject({ ok: true, commit: null });
    expect(staged.findings).toHaveLength(3);
  });

  it("writes and stages the body, the materialized template and the proposed event", async () => {
    const r = await repo();
    const w = await propose(r, "Use Aurora for orders");
    const id = idOf(w);
    const body = `docs/adr/decisions/${id}-use-aurora-for-orders.md`;
    expect(w).toMatchObject({
      format: "adr-write/v1",
      command: "new",
      ok: true,
      decision: { id, status: "proposed", title: "Use Aurora for orders", body_path: body },
      affected: [],
      commit: null,
      findings: [],
      notes: [],
    });
    expect(w.written.slice(0, 2)).toEqual([body, TEMPLATE]);
    expect(w.written[2]).toMatch(
      new RegExp(`^docs/adr/events/${id}/\\d{8}T\\d{6}Z-[0-9a-z]{4}-proposed\\.yaml$`),
    );
    expect((await staged(r)).sort()).toEqual([...w.written].sort());
    expect(await readFile(join(r.root, TEMPLATE), "utf8")).toBe(BUILTIN_TEMPLATES.nygard);
  });

  it("names the body <id>.md when the title has no letters or digits", async () => {
    const r = await repo();
    const w = await propose(r, "¿¡!?");
    expect(w.written[0]).toBe(`docs/adr/decisions/${idOf(w)}.md`);
  });

  it("reports the draft's template lint for sections left to fill in", async () => {
    const r = await repo();
    const w = await propose(r, "Unfilled", { sections: { context: "Why." } });
    expect(w.ok).toBe(true);
    expect(w.findings.map((f) => f.rule)).toEqual([
      "template/guidance-left",
      "template/guidance-left",
      "template/guidance-left",
    ]);
  });

  it("uses a repo template over the built-in one without copying it", async () => {
    const custom = BUILTIN_TEMPLATES.nygard?.replace("version: 1", "version: 2") ?? "";
    const r = await repo({ [TEMPLATE]: custom });
    const w = await propose(r, "Custom");
    expect(w.written).toHaveLength(2);
    expect(w.decision?.template).toEqual({ name: "nygard", version: 2 });
  });

  it("refuses bad arguments with UsageError and writes nothing", async () => {
    const r = await repo();
    const before = await porcelain(r);
    const cases: [Partial<ProposeInput>, RegExp][] = [
      [
        { template: "nope" },
        /^unknown template nope; add docs\/adr\/templates\/nope\.md or use one of madr, nygard, y-statement$/,
      ],
      [{ template: "Bad Name" }, /^invalid template name/],
      [{ sections: { nope: "x" } }, /^template nygard has no section nope/],
      [
        { sections: { context: "x".repeat(64 * 1024 + 1) } },
        /^section context is 65537 bytes; the limit is 65536/,
      ],
      [{ sections: { context: "a\0b" } }, /must not contain NUL/],
      [{ title: "two\nlines" }, /^the title must be a single line/],
      [{ title: "x".repeat(201) }, /^the title must be a single line/],
      [
        { supersedes: ["other:a7c2m9xd"] },
        /^cannot supersede other:a7c2m9xd: cross-log supersession isn't supported yet$/,
      ],
      [{ supersedes: ["ADR-0042"] }, /^unknown decision ADR-0042$/],
      [{ supersedes: ["a7c2m9xd"] }, /^unknown decision a7c2m9xd$/],
    ];
    for (const [input, message] of cases) {
      const attempt = propose(r, input.title ?? "Title", input);
      await expect(attempt).rejects.toThrow(UsageError);
      await expect(propose(r, input.title ?? "Title", input)).rejects.toThrow(message);
    }
    expect(await porcelain(r)).toBe(before);
  });

  it("refuses a repo template without a required scope section (exit 1)", async () => {
    const noScope = `---\ntemplate: lean\nversion: 1\nsections:\n  - id: context\n    heading: Context\n    required: true\n---\n# {{title}}\n\n## Context\n{{context}}\n`;
    const r = await repo({ "docs/adr/templates/lean.md": noScope });
    const before = await porcelain(r);
    const w = await proposeDecision(await open(r), {
      title: "Lean",
      template: "lean",
      actor: HUMAN,
    });
    expect(w).toMatchObject({ ok: false, decision: null, written: [], commit: null });
    expect(w.findings.map((f) => f.rule)).toEqual(["template/required-section"]);
    expect(await porcelain(r)).toBe(before);
  });
});

describe("acceptDecision", () => {
  it("hashes and stages the body as it is in the work tree", async () => {
    const r = await repo();
    const w = await propose(r, "Use Aurora");
    const body = w.written[0] ?? "";
    await writeFile(join(r.root, body), `${await readFile(join(r.root, body), "utf8")}\nMore.\n`);
    const a = await accept(r, idOf(w));
    expect(a).toMatchObject({
      ok: true,
      command: "accept",
      commit: null,
      decision: { status: "accepted", body_intact: true },
    });
    expect(await lines(r, "diff", "--name-only")).toEqual([]);
    expect(await git(r, "show", `:${body}`)).toContain("More.");
  });

  it("reports the number a commit on main assigned, and none without a commit", async () => {
    const r = await repo();
    const staged_ = await accept(r, idOf(await propose(r, "Staged")));
    expect(staged_.decision).toMatchObject({ number: null, display: idOf(staged_) });
    const a = await accept(r, idOf(await propose(r, "Committed")), { commit: true });
    expect(a.commit).toBe(await r.git.resolveCommit("HEAD"));
    expect(a.decision).toMatchObject({ number: 1, display: "ADR-0001" });
    const b = idOf(await propose(r, "Replacement", { supersedes: [idOf(a)], commit: true }));
    const cascade = await accept(r, b, { commit: true });
    expect(cascade.decision).toMatchObject({ id: b, number: 2, display: "ADR-0002" });
    expect(cascade.affected).toEqual([
      expect.objectContaining({
        id: idOf(a),
        number: 1,
        display: "ADR-0001",
        status: "superseded",
        effective: b,
      }),
    ]);
  });

  it("reports no number for a commit off main", async () => {
    const r = await repo();
    await r.checkout("topic", { create: true });
    const a = await accept(r, idOf(await propose(r, "On a branch")), { commit: true });
    expect(a.commit).toBe(await r.git.resolveCommit("HEAD"));
    expect(a.decision).toMatchObject({ number: null, display: idOf(a) });
  });

  it("returns no result when the commit fails, leaving the batch staged", async () => {
    const r = await repo();
    const id = idOf(await propose(r, "Hooked", { commit: true }));
    const head = await r.git.resolveCommit("HEAD");
    const hook = join(r.root, ".git", "hooks", "pre-commit");
    await mkdir(join(r.root, ".git", "hooks"), { recursive: true });
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await expect(accept(r, id, { commit: true })).rejects.toThrow();
    expect(await r.git.resolveCommit("HEAD")).toBe(head);
    expect((await staged(r)).some((p) => p.endsWith("-accepted.yaml"))).toBe(true);
    await rm(hook);
    const listed = await readDecisions(await open(r));
    expect(listed.projection.views.get(id)).toMatchObject({ status: "accepted", number: null });
  });

  it("refuses what the log forbids with ok false and writes nothing", async () => {
    const r = await repo();
    const target = idOf(await propose(r, "Target", { commit: true }));
    const declared = idOf(await propose(r, "Replacement", { supersedes: [target], commit: true }));
    // A commit without an editor refuses unfilled sections (design §7.2), so commit by hand.
    const unfilled = idOf(await propose(r, "Unfilled", { sections: {} }));
    await r.commit("unfilled");
    const rejected = idOf(await propose(r, "Rejected", { commit: true }));
    // After the real clock's proposal, so it applies.
    const later = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const [path, content] = eventFile(
      decisionEvent(rejected, "rejected", { reason: "no", at: later }),
    );
    await r.write(path, content);
    await r.stage(path);
    await r.commit("reject");
    const before = await porcelain(r);
    const refused = async (id: string, actor = HUMAN) => {
      const a = await accept(r, id, { actor });
      expect(a).toMatchObject({ ok: false, written: [], commit: null, affected: [] });
      expect(a.decision?.id).toBe(id);
      return a.findings.map((f) => [f.rule, f.subject, f.message]);
    };
    expect(await refused(rejected)).toEqual([
      [
        "transition/illegal",
        rejected,
        "accepted is not allowed while rejected; rejected is terminal",
      ],
    ]);
    expect((await refused(unfilled)).map(([rule]) => rule)).toEqual([
      "template/guidance-left",
      "template/guidance-left",
      "template/guidance-left",
      "template/guidance-left",
    ]);
    expect(await refused(target, TEST_AGENT)).toEqual([
      [
        "decision/agent-accepted",
        target,
        "accepted by agent test-agent; accept_requires_human needs a human",
      ],
    ]);
    expect(await refused(declared)).toEqual([
      ["transition/illegal", target, "superseded is not allowed while proposed"],
    ]);
    expect(await porcelain(r)).toBe(before);
  });

  it("refuses a hand-written cross-log supersession", async () => {
    const r = await repo();
    const id = idOf(await propose(r, "Cross", { commit: true }));
    const other = "k3f9q8a1";
    const hand = decisionEvent(other, "proposed", {
      data: proposedData("Hand", ["ext:a7c2m9xd"]),
    });
    const [path, content] = eventFile(hand);
    const body = `docs/adr/decisions/${other}.md`;
    await r.writeFiles({
      [path]: content,
      [body]: await readFile(join(r.root, `docs/adr/decisions/${id}-cross.md`), "utf8"),
    });
    await r.stage(path, body);
    await r.commit("hand-written");
    const a = await accept(r, other);
    expect(a.ok).toBe(false);
    expect(a.findings.map((f) => [f.rule, f.message])).toEqual([
      [
        "decision/reference-missing",
        "supersedes ext:a7c2m9xd: cross-log supersession isn't supported yet",
      ],
    ]);
  });

  it("commits the proposal, the acceptance and the template together after an uncommitted new", async () => {
    const r = await repo();
    const w = await propose(r, "Use Aurora");
    const id = idOf(w);
    await r.write("unrelated.txt", "x\n");
    await r.stage("unrelated.txt");
    const a = await accept(r, id, { commit: true });
    expect(a.commit).toBe(await r.git.resolveCommit("HEAD"));
    expect((await committed(r)).sort()).toEqual([...w.written, ...a.written].sort());
    expect(await headTrailers(r)).toEqual([...pairs(id, "proposed"), ...pairs(id, "accepted")]);
    expect((await firstParentHistory(r.git, "HEAD"))[0]?.subject).toBe(
      "docs(adr): decide to use Aurora",
    );
    expect(await staged(r)).toEqual(["unrelated.txt"]);
    expect(await verifyHead(r)).toEqual([]);
  });

  it("commits an involved decision's staged acceptance in a cascade", async () => {
    const r = await repo();
    // A title ending in "." gets one period in the body sentence.
    const b = idOf(await propose(r, "Old."));
    await accept(r, b);
    const c = idOf(await propose(r, "New", { supersedes: [b] }));
    const a = await accept(r, c, { commit: true });
    expect(a.affected.map((v) => [v.id, v.status, v.superseded_by])).toEqual([
      [b, "superseded", c],
    ]);
    const events = (await committed(r)).filter((p) => p.endsWith(".yaml")).sort();
    expect(events).toHaveLength(5);
    const extra = events.filter((p) => !a.written.includes(p));
    const typeOf = (p: string) => /-([a-z]+)\.yaml$/.exec(p)?.[1] ?? "";
    const subjectOf = (p: string) => p.split("/")[3] ?? "";
    expect(await headTrailers(r)).toEqual([
      ...extra.flatMap((p) => pairs(subjectOf(p), typeOf(p))),
      ...pairs(c, "accepted"),
      ...pairs(b, "superseded"),
    ]);
    expect((await firstParentHistory(r.git, "HEAD"))[0]?.subject).toBe("docs(adr): decide to new");
    // The superseded decision's acceptance is staged, not on main, so it has no number yet.
    expect(await git(r, "log", "-1", "--format=%B")).toMatch(
      new RegExp(`^docs\\(adr\\): decide to new\n\nSupersedes ${b}: Old\\.\n\nADR: `),
    );
    expect(await staged(r)).toEqual([]);
    expect(await verifyHead(r)).toEqual([]);
  });

  it("writes exact trailers for a two-target cascade", async () => {
    const r = await repo();
    const [x, y] = [idOf(await propose(r, "X")), idOf(await propose(r, "Y"))];
    await accept(r, x, { commit: true });
    await accept(r, y, { commit: true });
    const z = idOf(await propose(r, "Z", { supersedes: [y, x] }));
    await accept(r, z, { commit: true });
    const targets = [x, y].sort();
    expect(await headTrailers(r)).toEqual([
      ...pairs(z, "proposed"),
      ...pairs(z, "accepted"),
      ...targets.flatMap((t) => pairs(t, "superseded")),
    ]);
    expect(await verifyHead(r)).toEqual([]);
  });

  it("refuses --commit while the template has unstaged changes, writing nothing", async () => {
    const r = await repo();
    const id = idOf(await propose(r, "Use Aurora"));
    await writeFile(join(r.root, TEMPLATE), `${BUILTIN_TEMPLATES.nygard}\n`);
    const before = await porcelain(r);
    await expect(accept(r, id, { commit: true })).rejects.toThrow(
      new UsageError(
        `${TEMPLATE} has unstaged changes; stage or discard them, or run without --commit`,
      ),
    );
    expect(await porcelain(r)).toBe(before);
  });

  it("ignores stray files in an events directory but refuses an untracked event file", async () => {
    const r = await repo();
    const id = idOf(await propose(r, "Use Aurora", { commit: true }));
    await r.writeFiles({
      [`docs/adr/events/${id}/.DS_Store`]: "finder",
      [`docs/adr/events/${id}/notes.txt`]: "mine",
    });
    const a = await accept(r, id, { commit: true });
    expect(a.commit).not.toBeNull();
    const tree = await lines(r, "ls-tree", "-r", "--name-only", "HEAD");
    expect(
      tree.filter((p) => p.includes(id) && !p.endsWith(".yaml") && !p.endsWith(".md")),
    ).toEqual([]);
    expect(await verifyHead(r)).toEqual([]);

    const other = idOf(await propose(r, "Other", { commit: true }));
    const stray = `docs/adr/events/${other}/stray.yaml`;
    await r.write(stray, "x: 1\n");
    const before = await porcelain(r);
    await expect(accept(r, other, { commit: true })).rejects.toThrow(
      new UsageError(`${stray} is not tracked; git add it, or run without --commit`),
    );
    expect(await porcelain(r)).toBe(before);
  });

  it("leaves a staged deletion in the scope staged and out of the commit", async () => {
    const r = await repo();
    const id = idOf(await propose(r, "Use Aurora", { commit: true }));
    await git(r, "rm", "-q", "--", TEMPLATE);
    const a = await accept(r, id, { commit: true });
    expect(a.ok).toBe(true);
    expect(await lines(r, "ls-tree", "-r", "--name-only", "HEAD")).toContain(TEMPLATE);
    expect(await lines(r, "diff", "--cached", "--name-status")).toEqual([`D\t${TEMPLATE}`]);
  });
});

describe("a repo template with --commit", () => {
  it("is refused while untracked and accepted once added", async () => {
    const team = BUILTIN_TEMPLATES.nygard?.replace("template: nygard", "template: team") ?? "";
    const r = await repo();
    await r.write("docs/adr/templates/team.md", team);
    const before = await porcelain(r);
    await expect(propose(r, "Team", { template: "team", commit: true })).rejects.toThrow(
      new UsageError(
        "docs/adr/templates/team.md is not tracked; git add it, or run without --commit",
      ),
    );
    expect(await porcelain(r)).toBe(before);
    await r.stage("docs/adr/templates/team.md");
    const w = await propose(r, "Team", { template: "team", commit: true });
    expect(w.commit).not.toBeNull();
    expect(await committed(r)).toContain("docs/adr/templates/team.md");
    expect(await verifyHead(r)).toEqual([]);
  });
});

describe("supersedeDecision", () => {
  const setup = async () => {
    const r = await repo();
    const a = idOf(await propose(r, "Old", { commit: true }));
    await accept(r, a, { commit: true });
    const b = idOf(await propose(r, "New", { commit: true }));
    return { r, a, b };
  };
  const supersede = async (
    r: TempRepo,
    id: string,
    by: string,
    o: { commit?: boolean; reason?: string } = {},
  ) =>
    supersedeDecision(
      await open(r),
      { id, by, actor: HUMAN, ...(o.reason === undefined ? {} : { reason: o.reason }) },
      o.commit === undefined ? {} : { commit: o.commit },
    );

  it("commits the successor's staged acceptance with the supersession", async () => {
    const { r, a, b } = await setup();
    await accept(r, b);
    const s = await supersede(r, a, b, { commit: true, reason: "faster" });
    expect(s).toMatchObject({
      ok: true,
      command: "supersede",
      decision: { id: a, status: "superseded", effective: b, number: 1, display: "ADR-0001" },
      affected: [{ id: a, status: "superseded", number: 1, display: "ADR-0001" }],
    });
    expect(await headTrailers(r)).toEqual([...pairs(b, "accepted"), ...pairs(a, "superseded")]);
    expect(await staged(r)).toEqual([]);
    expect(await verifyHead(r)).toEqual([]);
    expect(await readFile(join(r.root, s.written[0] ?? ""), "utf8")).toContain("reason: faster");
  });

  it("refuses what the log forbids and writes nothing", async () => {
    const { r, a, b } = await setup();
    const before = await porcelain(r);
    const rules = async (id: string, by: string) => {
      const s = await supersede(r, id, by);
      expect(s).toMatchObject({ ok: false, written: [] });
      return s.findings.map((f) => [f.rule, f.message]);
    };
    expect(await rules(a, b)).toEqual([
      ["decision/superseded-by-unaccepted", `superseded by ${b}, which is not accepted`],
    ]);
    expect(await rules(b, a)).toEqual([
      ["transition/illegal", "superseded is not allowed while proposed"],
    ]);
    expect(await rules(a, a)).toEqual([
      ["decision/supersession-cycle", `supersession cycle: ${a} → ${a}`],
    ]);
    await expect(supersede(r, a, `ext:${b}`)).rejects.toThrow(
      new UsageError(`--by ext:${b}: cross-log supersession isn't supported yet`),
    );
    await expect(supersede(r, a, b, { reason: "  " })).rejects.toThrow(UsageError);
    await expect(supersede(r, a, "zzzzzzzz")).rejects.toThrow(/^unknown decision zzzzzzzz$/);
    expect(await porcelain(r)).toBe(before);
  });
});

// Design §6.8 (D-i): the library owns the no-commit rule of --follow-renames.
describe("followScopeRenames", () => {
  async function renamed(): Promise<{ r: TempRepo; id: string }> {
    const r = await repo({
      "docs/adr/adr.toml": "[policy]\nauto_commit = true\n",
      "src/orders/api.ts": "export {}\n",
    });
    const id = idOf(await propose(r, "Use Aurora"));
    const scoped = await scopeDecision(await open(r), {
      id,
      op: { set: ["src/orders/**"] },
      actor: HUMAN,
    });
    expect(scoped.commit).not.toBeNull();
    await git(r, "mv", "src/orders", "src/billing");
    return { r, id };
  }
  const NOTE = "--follow-renames never commits; commit the scoped events with the renames";

  it("plans without writing in a dry run, and stages without committing otherwise", async () => {
    const { r, id } = await renamed();
    const before = await porcelain(r);
    const head = await r.git.resolveCommit("HEAD");
    const dry = await followScopeRenames(await open(r), { actor: HUMAN }, { dryRun: true });
    expect(dry).toMatchObject({
      ok: true,
      decision: null,
      written: [],
      commit: null,
      notes: [NOTE],
    });
    expect(dry.affected.map((v) => [v.id, v.applies_to])).toEqual([[id, ["src/billing/**"]]]);
    expect(await porcelain(r)).toBe(before);

    const real = await followScopeRenames(await open(r), { actor: HUMAN });
    expect(real).toMatchObject({ ok: true, decision: null, commit: null, notes: [NOTE] });
    expect(real.affected.map((v) => [v.id, v.applies_to])).toEqual([[id, ["src/billing/**"]]]);
    expect(real.written).toHaveLength(1);
    expect(await staged(r)).toContain(real.written[0]);
    expect(await r.git.resolveCommit("HEAD")).toBe(head);
  });

  it("refuses commit: true and a message", async () => {
    const { r } = await renamed();
    const log = await open(r);
    await expect(followScopeRenames(log, { actor: HUMAN }, { commit: true })).rejects.toThrow(
      InvalidArgumentError,
    );
    await expect(followScopeRenames(log, { actor: HUMAN }, { message: "x" })).rejects.toThrow(
      InvalidArgumentError,
    );
    expect(await followScopeRenames(log, { actor: HUMAN }, { commit: false })).toMatchObject({
      ok: true,
      commit: null,
    });
  });
});

describe("the EventExistsError retry", () => {
  it("leaves no files from the failed attempt", async () => {
    const r = await repo();
    let calls = 0;
    let firstBody = "";
    const deps: WriteDeps = {
      now: Date.now,
      async apply(log, plan, o) {
        calls++;
        if (calls === 1) {
          // Another process writes the same event path between the plan and the write.
          firstBody = Object.keys(plan.files)[0] ?? "";
          const [path] = Object.keys(plan.files).filter((p) => p.endsWith(".yaml"));
          await r.write(path ?? "", "x: 1\n");
        }
        return applyPlan(log, plan, o);
      },
    };
    const w = await proposeDecision(
      await open(r),
      { title: "Retry", sections: SECTIONS, actor: HUMAN },
      {},
      deps,
    );
    expect(calls).toBe(2);
    expect(w.ok).toBe(true);
    expect(w.written[0]).not.toBe(firstBody);
    const files = await lines(
      r,
      "ls-files",
      "--others",
      "--cached",
      "--",
      "docs/adr/decisions",
      "docs/adr/templates",
    );
    expect(files.sort()).toEqual([w.written[0], TEMPLATE].sort());
  });

  it("gives up after a second collision", async () => {
    const r = await repo();
    const deps: WriteDeps = {
      now: Date.now,
      async apply() {
        throw new EventExistsError("docs/adr/events/x/y.yaml");
      },
    };
    await expect(
      proposeDecision(
        await open(r),
        { title: "Retry", sections: SECTIONS, actor: HUMAN },
        {},
        deps,
      ),
    ).rejects.toThrow(EventExistsError);
  });
});

describe("the editor step", () => {
  const nygard = (() => {
    const p = parseTemplate(BUILTIN_TEMPLATES.nygard ?? "", { path: TEMPLATE });
    if (!p.ok) throw new Error("nygard does not parse");
    return p.template;
  })();
  const run = async (
    r: TempRepo,
    edit: (abs: string) => Promise<string | null>,
    o: { commit?: boolean; sections?: Record<string, string> } = {},
  ) => {
    const notes: string[] = [];
    const w = await proposeDecision(
      await open(r),
      { title: "Edited", sections: o.sections ?? SECTIONS, actor: HUMAN },
      { commit: o.commit ?? true, edit, onNote: (n) => notes.push(n) },
    );
    return { w, notes, body: w.written[0] ?? "" };
  };
  const filled = (title: string) =>
    `# ${title}\n\n## Context\nc\n\n## Decision\nd\n\n## Scope\ns\n\n## Consequences\nx\n`;

  it("commits the edited body and lints it", async () => {
    const r = await repo();
    const head = await r.git.resolveCommit("HEAD");
    const { w, notes, body } = await run(
      r,
      async (abs) => {
        await writeFile(abs, filled("Edited"));
        return null;
      },
      { sections: {} },
    );
    expect(w.commit).not.toBeNull();
    expect(w.commit).not.toBe(head);
    expect(w.findings).toEqual([]);
    expect(notes).toEqual([]);
    expect(await git(r, "show", `HEAD:${body}`)).toBe(filled("Edited"));
    expect(await lines(r, "diff", "--name-only", "--", body)).toEqual([]);
    expect(await lines(r, "diff", "--cached", "--name-only", "--", body)).toEqual([]);
  });

  it("stages the edited body without --commit", async () => {
    const r = await repo();
    const { w, body } = await run(
      r,
      async (abs) => {
        await writeFile(abs, `${await readFile(abs, "utf8")}\nAppended line.\n`);
        return null;
      },
      { commit: false },
    );
    expect(w.commit).toBeNull();
    expect(await git(r, "diff", "--cached", "--", body)).toContain("+Appended line.");
    expect(await git(r, "diff", "--", body)).toBe("");
  });

  it("commits the render when the editor fails without touching the body", async () => {
    const r = await repo();
    const { w, notes, body } = await run(r, async () => "the editor exited with status 1");
    expect(w.commit).not.toBeNull();
    expect(notes).toEqual([]);
    expect(await git(r, "show", `HEAD:${body}`)).toContain("We will use Aurora.");
  });

  it("skips the commit when the editor fails after changing the body, keeping the edit", async () => {
    const r = await repo();
    const head = await r.git.resolveCommit("HEAD");
    let rendered = "";
    const { w, notes, body } = await run(r, async (abs) => {
      rendered = await readFile(abs, "utf8");
      await writeFile(abs, `${rendered}\nHalf done.\n`);
      return "the editor exited with status 1";
    });
    expect(w).toMatchObject({ ok: true, commit: null });
    expect(notes).toEqual([
      `${body} changed while the editor failed; review it, then git add it and commit`,
    ]);
    expect(await r.git.resolveCommit("HEAD")).toBe(head);
    expect(await git(r, "show", `:${body}`)).toBe(rendered);
    expect(await readFile(join(r.root, body), "utf8")).toContain("Half done.");
  });

  it("skips the commit when the body is removed, keeping the render staged (NIT 1)", async () => {
    const r = await repo();
    const head = await r.git.resolveCommit("HEAD");
    let rendered = "";
    const { w, notes, body } = await run(
      r,
      async (abs) => {
        rendered = await readFile(abs, "utf8");
        await rm(abs);
        return null;
      },
      { sections: { context: "Why." } },
    );
    expect(w).toMatchObject({ ok: true, commit: null });
    expect(await r.git.resolveCommit("HEAD")).toBe(head);
    expect(await git(r, "show", `:${body}`)).toBe(rendered);
    expect(w.findings).toEqual(lintDocument(nygard, rendered, { file: body, subject: idOf(w) }));
    expect(w.findings).toHaveLength(3);
    expect(notes).toEqual([
      `${body} was removed while editing; the rendered draft is still staged. Restore it with \`git checkout -- ${body}\``,
    ]);
  });

  it("skips the commit when the edited draft still has unfilled sections", async () => {
    const r = await repo();
    const head = await r.git.resolveCommit("HEAD");
    const { w, notes, body } = await run(r, async () => null, { sections: { context: "Why." } });
    expect(w).toMatchObject({ ok: true, commit: null });
    expect(w.findings).toHaveLength(3);
    expect(notes).toEqual([
      `${body} still has unfilled required sections; fill them in, then commit`,
    ]);
    expect(await r.git.resolveCommit("HEAD")).toBe(head);
    expect(await lines(r, "diff", "--cached", "--name-only", "--", body)).toEqual([body]);
  });

  it("skips the commit when the template changes while the editor is open (NIT 2)", async () => {
    const r = await repo();
    const head = await r.git.resolveCommit("HEAD");
    const { w, notes } = await run(r, async () => {
      await writeFile(join(r.root, TEMPLATE), `${BUILTIN_TEMPLATES.nygard}\n<!-- edited -->\n`);
      return null;
    });
    expect(w).toMatchObject({ ok: true, commit: null });
    expect(await r.git.resolveCommit("HEAD")).toBe(head);
    expect(await git(r, "show", `:${TEMPLATE}`)).toBe(BUILTIN_TEMPLATES.nygard);
    expect(notes).toEqual([
      `${TEMPLATE} changed while the editor was open; review it, then git add it and commit`,
    ]);
  });
});
