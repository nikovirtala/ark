import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EventEnvelope } from "../envelope/types.js";
import { serializeEvent } from "../envelope/yaml.js";
import {
  CommitFailedError,
  ConfigError,
  EventExistsError,
  InvalidArgumentError,
} from "../errors.js";
import { finding } from "../findings/finding.js";
import { eventDir, eventPath } from "../identity/layout.js";
import { exampleMachineKind as kind } from "../testing/example-machine-kind.js";
import { TEST_HUMAN } from "../testing/history.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import type { AppliedPlan } from "./apply-plan.js";
import { openToolLog, type ToolLog } from "./tool-log.js";
import {
  checkCommitIdentity,
  checkWorkTree,
  type DriverPlan,
  type PlanContext,
  type PlanRefusal,
  planContext,
  type RunWriteOptions,
  readIfPresent,
  runWrite,
  sameBytes,
  viewsAfter,
  type WriteOutcome,
} from "./write-driver.js";

const A = "aaaaaaaa";
const B = "bbbbbbbb";
const layout = kind.layoutAt("log");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (s: string) => encoder.encode(s);

function ev(subject: string, type: string, second: number): EventEnvelope {
  return {
    envelope: "ledger/v1",
    kind: "widget",
    schema: "widget/v1",
    id: `01JGFJJZ00000000000000${String(second).padStart(4, "0")}`,
    subject,
    type,
    at: `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`,
    actor: TEST_HUMAN,
    data: type === "created" ? { title: "Gear" } : type === "noted" ? { text: "a note" } : {},
  };
}

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function setup(
  o: { readonly ref?: string; readonly reader?: "index" } = {},
): Promise<{ r: TempRepo; log: ToolLog }> {
  const created = ev(A, "created", 0);
  const r = await createTempRepo({
    files: {
      "log/items/aaaaaaaa.md": "# Gear\n",
      [eventPath(layout, created)]: serializeEvent(created),
    },
  });
  repos.push(r);
  const log = await openToolLog({
    cwd: r.root,
    tool: "widget",
    kind,
    gitOptions: { env: r.env },
    ...o,
  });
  return { r, log };
}
const status = async (r: TempRepo) =>
  decoder.decode((await r.git.run(["status", "--porcelain"])).stdout);

interface View {
  readonly id: string;
  readonly n: number | null;
}
interface Plan extends DriverPlan {
  readonly primary: View | null;
  readonly affected: readonly View[];
}
interface Read {
  readonly root: string;
  readonly attempt: number;
}
interface Refusal extends PlanRefusal {
  readonly subject: string;
}
type Doc =
  | { readonly ok: true; readonly outcome: WriteOutcome<View> }
  | { readonly ok: false; readonly subject: string; readonly notes: readonly string[] };

/** A `noted` event on A; its views are A and B, numberless. */
function notePlan(o: Partial<Plan> = {}): Plan {
  const noted = ev(A, "noted", 2);
  const path = eventPath(layout, noted);
  return {
    subject: A,
    files: { [path]: bytes(serializeEvent(noted)) },
    events: [noted],
    stage: [path],
    commitScope: [eventDir(layout, A)],
    eventDirs: [eventDir(layout, A)],
    trailers: [],
    findings: [finding({ severity: "warning", rule: "plan/own", message: "the plan's" })],
    notes: ["plan"],
    commit: { action: "note" },
    draft: null,
    primary: { id: A, n: null },
    affected: [{ id: B, n: null }],
    ...o,
  };
}
const emptyPlan = (o: Partial<Plan> = {}) => notePlan({ files: {}, events: [], stage: [], ...o });

const applied = (o: Partial<AppliedPlan> = {}): AppliedPlan => ({
  written: ["written"],
  commit: null,
  findings: [],
  notes: ["applied"],
  rendered: null,
  ...o,
});

/** `runWrite` with test bindings, counting reads and recording apply calls. */
function drive(
  log: ToolLog,
  o: Partial<RunWriteOptions<Read, Plan, Refusal, View, Doc>> = {},
): {
  run: () => Promise<Doc>;
  reads: () => number;
  applies: { plan: Plan; read: Read; commit: boolean }[];
  contexts: PlanContext[];
} {
  let reads = 0;
  const applies: { plan: Plan; read: Read; commit: boolean }[] = [];
  const contexts: PlanContext[] = [];
  const run = () =>
    runWrite<Read, Plan, Refusal, View, Doc>({
      log: { ...log, notes: ["located"] },
      autoCommit: false,
      notes: ["caller"],
      deps: { now: () => 0 },
      builtins: {},
      read: async () => ({ root: "log", attempt: reads++ }),
      plan: async (_read, c) => {
        contexts.push(c);
        return { ok: true, plan: notePlan() };
      },
      views: (p) => ({ primary: p.primary, affected: p.affected }),
      reread: async () => new Map(),
      refused: (r, notes) => ({ ok: false, subject: r.subject, notes }),
      done: (outcome) => ({ ok: true, outcome }),
      ...o,
      apply: async (plan, read, commit) => {
        applies.push({ plan, read, commit });
        return o.apply === undefined ? applied() : o.apply(plan, read, commit);
      },
    });
  return { run, reads: () => reads, applies, contexts };
}
const outcomeOf = (d: Doc): WriteOutcome<View> => {
  if (!d.ok) throw new Error("expected a written document");
  return d.outcome;
};

describe("runWrite", () => {
  it("applies the plan and reports the notes in order: log, caller, plan, applied", async () => {
    const { log } = await setup();
    const d = drive(log, { apply: async () => applied({ rendered: shortened }) });
    const outcome = outcomeOf(await d.run());
    expect(outcome).toEqual({
      primary: { id: A, n: null },
      affected: [{ id: B, n: null }],
      written: ["written"],
      commit: null,
      findings: [],
      notes: ["located", "caller", "plan", "applied"],
    });
    expect(d.applies.map((a) => a.commit)).toEqual([false]);
  });

  it("after a commit, reports the views read again and the shortened-subject note last", async () => {
    const { log } = await setup();
    const rereads: string[] = [];
    const d = drive(log, {
      commit: true,
      apply: async () => applied({ commit: "c0ffee", rendered: shortened }),
      reread: async (sha) => {
        rereads.push(sha);
        return new Map([[A, { id: A, n: 7 }]]);
      },
    });
    const outcome = outcomeOf(await d.run());
    expect(rereads).toEqual(["c0ffee"]);
    expect(outcome.primary).toEqual({ id: A, n: 7 });
    // A view the new read lacks stays the plan's.
    expect(outcome.affected).toEqual([{ id: B, n: null }]);
    expect(outcome.commit).toBe("c0ffee");
    expect(outcome.notes).toEqual(["located", "caller", "plan", "applied", "subject shortened"]);
    expect(d.applies.map((a) => a.commit)).toEqual([true]);
  });

  it("commits with autoCommit when commit isn't given, and not when commit is false", async () => {
    const { log } = await setup();
    const auto = drive(log, { autoCommit: true });
    await auto.run();
    expect(auto.applies.map((a) => a.commit)).toEqual([true]);
    const off = drive(log, { autoCommit: true, commit: false });
    await off.run();
    expect(off.applies.map((a) => a.commit)).toEqual([false]);
  });

  it("plans and applies once more on an EventExistsError, with a fresh read", async () => {
    const { log } = await setup();
    let calls = 0;
    const d = drive(log, {
      apply: async () => {
        calls++;
        if (calls === 1) throw new EventExistsError("log/events/x.yaml");
        return applied();
      },
    });
    expect(outcomeOf(await d.run()).written).toEqual(["written"]);
    expect(d.applies.map((a) => a.read.attempt)).toEqual([0, 1]);
    expect(d.contexts).toHaveLength(2);
  });

  it("rethrows a second EventExistsError, and any other error at once", async () => {
    const { log } = await setup();
    const twice = drive(log, {
      apply: async () => {
        throw new EventExistsError("log/events/x.yaml");
      },
    });
    await expect(twice.run()).rejects.toBeInstanceOf(EventExistsError);
    expect(twice.applies).toHaveLength(2);
    const boom = drive(log, {
      apply: async () => {
        throw new Error("boom");
      },
    });
    await expect(boom.run()).rejects.toThrow("boom");
    expect(boom.applies).toHaveLength(1);
  });

  it("puts the log's, the caller's and the plan's notes before a CommitFailedError's", async () => {
    const { log } = await setup();
    const failed = new CommitFailedError({
      recovery: { staged: ["log/a.yaml"], messageFile: "/m", command: "git commit", trailers: [] },
      headline: "git commit failed",
      detail: "",
      rerun: "Don't run it again.",
      before: null,
      after: null,
      notes: ["applied so far"],
    });
    const d = drive(log, {
      apply: async () => {
        throw failed;
      },
    });
    const err = await d.run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommitFailedError);
    expect((err as CommitFailedError).notes).toEqual([
      "located",
      "caller",
      "plan",
      "applied so far",
    ]);
    expect(d.applies).toHaveLength(1);
  });

  it("reports a plan with nothing to write without applying it", async () => {
    const { r, log } = await setup();
    const d = drive(log, { commit: true, plan: async () => ({ ok: true, plan: emptyPlan() }) });
    const outcome = outcomeOf(await d.run());
    expect(d.applies).toEqual([]);
    expect(outcome).toEqual({
      primary: { id: A, n: null },
      affected: [{ id: B, n: null }],
      written: [],
      commit: null,
      findings: notePlan().findings,
      notes: ["located", "caller", "plan"],
    });
    expect(await status(r)).toBe("");
  });

  it("counts a plan that only replaces a file as something to write", async () => {
    const { log } = await setup();
    const replace = {
      "log/items/aaaaaaaa.md": { bytes: bytes("# B\n"), expected: bytes("# Gear\n") },
    };
    const d = drive(log, { plan: async () => ({ ok: true, plan: emptyPlan({ replace }) }) });
    await d.run();
    expect(d.applies).toHaveLength(1);
  });

  it("with dryRun reports the plan's views and notes without writing or reading again", async () => {
    const { r, log } = await setup();
    let rereads = 0;
    const d = drive(log, {
      dryRun: true,
      reread: async () => {
        rereads++;
        return new Map();
      },
    });
    const outcome = outcomeOf(await d.run());
    expect(d.applies).toEqual([]);
    expect(rereads).toBe(0);
    expect(outcome).toEqual({
      primary: { id: A, n: null },
      affected: [{ id: B, n: null }],
      written: [],
      commit: null,
      findings: notePlan().findings,
      notes: ["located", "caller", "plan"],
    });
    expect(await status(r)).toBe("");
  });

  it("with requireCommitParts refuses to commit a plan without commit parts, before applying", async () => {
    const { r, log } = await setup();
    const plan = async () => ({ ok: true as const, plan: notePlan({ commit: null }) });
    const guarded = drive(log, { commit: true, requireCommitParts: true, plan });
    await expect(guarded.run()).rejects.toThrow(
      new InvalidArgumentError("this write can't be committed"),
    );
    expect(guarded.applies).toEqual([]);
    expect(await status(r)).toBe("");
    // Without a commit, or without the guard, the plan is applied.
    const unstaged = drive(log, { commit: false, requireCommitParts: true, plan });
    await unstaged.run();
    expect(unstaged.applies).toHaveLength(1);
    const unguarded = drive(log, { commit: true, plan });
    await unguarded.run();
    expect(unguarded.applies).toHaveLength(1);
  });

  it("reports a refusal with the log's and the caller's notes, then refusalNotes'", async () => {
    const { log } = await setup();
    const refusal: Refusal = { ok: false, subject: A, findings: [], notes: ["refusal's own"] };
    const plan = async () => refusal;
    const plain = drive(log, { plan });
    expect(await plain.run()).toEqual({ ok: false, subject: A, notes: ["located", "caller"] });
    const withNotes = drive(log, { plan, refusalNotes: (r) => r.notes ?? [] });
    expect(await withNotes.run()).toEqual({
      ok: false,
      subject: A,
      notes: ["located", "caller", "refusal's own"],
    });
    expect([...plain.applies, ...withNotes.applies]).toEqual([]);
  });

  it("refuses a log opened at a ref or with the index reader, before reading", async () => {
    const at = await setup({ ref: "HEAD" });
    const d = drive(at.log);
    await expect(d.run()).rejects.toThrow(
      new InvalidArgumentError("writes read the work tree; open the log without a ref"),
    );
    const index = await setup({ reader: "index" });
    const e = drive(index.log);
    await expect(e.run()).rejects.toThrow(
      new InvalidArgumentError("writes read the work tree; open the log with the worktree reader"),
    );
    expect(d.reads() + e.reads()).toBe(0);
  });

  it("checks the identity only when committing, before reading", async () => {
    const { r } = await setup();
    // The author identity alone, as with GIT_AUTHOR_* set: git commit still needs a committer.
    const { GIT_COMMITTER_NAME: _, GIT_COMMITTER_EMAIL: __, ...env } = r.env;
    const noIdentity = await openToolLog({
      cwd: r.root,
      tool: "widget",
      kind,
      gitOptions: { env },
    });
    expect(await noIdentity.git.committerIdentity()).toBeNull();
    const d = drive(noIdentity, { commit: true });
    await expect(d.run()).rejects.toThrow(
      new ConfigError("--commit needs a git identity; set git user.name and user.email"),
    );
    expect(d.reads()).toBe(0);
    const e = drive(noIdentity, { commit: false });
    await e.run();
    expect(e.applies).toHaveLength(1);
  });

  it("plans with the deps, the builtins and the log's templates", async () => {
    const { log } = await setup();
    const now = () => 42;
    const random = (buf: Uint8Array) => buf.fill(1);
    const d = drive(log, { deps: { now, random }, builtins: { plain: "x" } });
    await d.run();
    const [c] = d.contexts;
    expect(c?.now).toBe(now);
    expect(c?.random).toBe(random);
    expect(c?.builtins).toEqual({ plain: "x" });
    const e = drive(log);
    await e.run();
    expect(e.contexts[0] !== undefined && "random" in e.contexts[0]).toBe(false);
  });
});

const shortened = {
  message: "m",
  subject: "m",
  shortened: true,
  note: "subject shortened",
};

describe("checkCommitIdentity", () => {
  it("refuses a missing author or committer identity", async () => {
    const message = "--commit needs a git identity; set git user.name and user.email";
    const git = (author: unknown, committer: unknown) => ({
      identity: async () => author as never,
      committerIdentity: async () => committer as never,
    });
    await expect(checkCommitIdentity(git(null, {}))).rejects.toThrow(new ConfigError(message));
    await expect(checkCommitIdentity(git({}, null))).rejects.toThrow(new ConfigError(message));
    await expect(checkCommitIdentity(git({}, {}))).resolves.toBeUndefined();
  });
});

describe("checkWorkTree", () => {
  it("accepts a work-tree log", async () => {
    const { log } = await setup();
    expect(() => checkWorkTree(log)).not.toThrow();
  });
});

describe("planContext", () => {
  it("reads the templates under the root from the work tree, else from the history", async () => {
    const { r, log } = await setup();
    const text = (version: number, heading: string) =>
      `---\ntemplate: lite\nversion: ${version}\nsections:\n  - id: context\n    heading: ${heading}\n    required: true\n---\n# {{title}}\n\n## ${heading}\n{{context}}\n`;
    await r.write("log/templates/lite.md", text(1, "Background"));
    await r.stage("log/templates/lite.md");
    await r.commit("lite v1");
    await r.write("log/templates/lite.md", text(2, "Context"));
    const c = await planContext(log, "log", {}, { now: () => 0 });
    const v1 = await c.templates.get("lite", 1);
    expect(v1.ok && v1.template.sections[0]?.heading).toBe("Background");
    const v2 = await c.templates.get("lite", 2);
    expect(v2.ok && v2.template.sections[0]?.heading).toBe("Context");
  });
});

describe("viewsAfter", () => {
  const views = { primary: { id: A, n: null }, affected: [{ id: B, n: null }] };
  it("gives the plan's views without a commit, without reading", async () => {
    let reads = 0;
    const got = await viewsAfter(null, views, async () => {
      reads++;
      return new Map();
    });
    expect(got).toBe(views);
    expect(reads).toBe(0);
  });

  it("maps each view through the new read, keeping one it lacks", async () => {
    const got = await viewsAfter("c0ffee", views, async (sha) =>
      sha === "c0ffee" ? new Map([[B, { id: B, n: 2 }]]) : new Map(),
    );
    expect(got).toEqual({ primary: { id: A, n: null }, affected: [{ id: B, n: 2 }] });
    expect(
      await viewsAfter("c0ffee", { primary: null, affected: [] }, async () => new Map()),
    ).toEqual({ primary: null, affected: [] });
  });
});

describe("sameBytes and readIfPresent", () => {
  it("compares bytes and reads a file, or null when it's missing", async () => {
    expect(sameBytes(bytes("ab"), bytes("ab"))).toBe(true);
    expect(sameBytes(bytes("ab"), bytes("ac"))).toBe(false);
    expect(sameBytes(bytes("ab"), bytes("abc"))).toBe(false);
    const { r } = await setup();
    const path = join(r.root, "log/items/aaaaaaaa.md");
    expect(await readIfPresent(path)).toEqual(await readFile(path));
    expect(await readIfPresent(join(r.root, "missing.md"))).toBeNull();
    await expect(readIfPresent(join(r.root, "log"))).rejects.toThrow();
  });
});
