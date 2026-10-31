import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EventEnvelope } from "../envelope/types.js";
import { serializeEvent } from "../envelope/yaml.js";
import { CommitFailedError, InvalidArgumentError, UsageError } from "../errors.js";
import { finding } from "../findings/finding.js";
import type { TreeReader } from "../git/tree.js";
import { eventDir, eventPath } from "../identity/layout.js";
import { unstagedIndexText } from "../log-index/tool-render.js";
import { exampleMachineKind as kind } from "../testing/example-machine-kind.js";
import { TEST_HUMAN } from "../testing/history.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import {
  type AfterStage,
  type ApplyPlanOptions,
  applyPlan,
  type ComposeInput,
  type IndexRender,
  unstagedIndexNote,
  WRITE_RERUN,
  type WritePlan,
} from "./apply-plan.js";
import type { RenderedCommit } from "./commit-message.js";
import { indexBeforeHint } from "./tool-index.js";
import { openToolLog, type ToolLog } from "./tool-log.js";

const A = "aaaaaaaa";
const B = "bbbbbbbb";
const layout = kind.layoutAt("log");
const INDEX = "log/index.md";
const bodyOf = (s: string) => `log/items/${s}.md`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (s: string) => encoder.encode(s);

function ev(subject: string, type: string, second: number): EventEnvelope {
  const data = type === "created" ? { title: "Gear" } : type === "noted" ? { text: "a note" } : {};
  return {
    envelope: "ledger/v1",
    kind: "widget",
    schema: "widget/v1",
    id: `01JGFJJZ00000000000000${String(second).padStart(4, "0")}`,
    subject,
    type,
    at: `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`,
    actor: TEST_HUMAN,
    data,
  };
}
const fileOf = (e: EventEnvelope) => ({ [eventPath(layout, e)]: bytes(serializeEvent(e)) });

/** A's body and `created` event, committed; plus `extra` files. */
const initialFiles = (extra: Record<string, string> = {}) => ({
  [bodyOf(A)]: "# Gear\n",
  [eventPath(layout, ev(A, "created", 0))]: serializeEvent(ev(A, "created", 0)),
  ...extra,
});

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function setup(extra?: Record<string, string>): Promise<{ r: TempRepo; log: ToolLog }> {
  const r = await createTempRepo({ files: initialFiles(extra) });
  repos.push(r);
  const log = await openToolLog({ cwd: r.root, tool: "widget", kind, gitOptions: { env: r.env } });
  return { r, log };
}

const out = async (r: TempRepo, args: string[]) => decoder.decode((await r.git.run(args)).stdout);
const staged = async (r: TempRepo) =>
  (await out(r, ["diff", "--cached", "--name-only"])).split("\n").filter((l) => l !== "");
const head = async (r: TempRepo) => (await out(r, ["rev-parse", "HEAD"])).trim();
const work = (r: TempRepo, path: string) => readFile(join(r.root, path), "utf8");

/** `new` of B: its body and `created` event. */
function newPlan(o: Partial<WritePlan> = {}): WritePlan {
  const created = ev(B, "created", 1);
  return {
    subject: B,
    files: { [bodyOf(B)]: bytes("# Planned\n"), ...fileOf(created) },
    events: [created],
    stage: [bodyOf(B), eventPath(layout, created)],
    commitScope: [bodyOf(B), eventDir(layout, B)],
    eventDirs: [eventDir(layout, B)],
    trailers: [
      ["W", B],
      ["W-Event", "created"],
    ],
    findings: [],
    ...o,
  };
}

/** A `noted` event on A, scoped to A's body and events. */
function notePlan(o: Partial<WritePlan> = {}): WritePlan {
  const noted = ev(A, "noted", 2);
  return {
    subject: A,
    files: fileOf(noted),
    events: [noted],
    stage: [eventPath(layout, noted)],
    commitScope: [bodyOf(A), eventDir(layout, A)],
    eventDirs: [eventDir(layout, A)],
    trailers: [
      ["W", A],
      ["W-Event", "noted"],
    ],
    findings: [],
    ...o,
  };
}

const BINDING = {
  trailerKeys: { subject: "W", event: "W-Event" },
  tool: "widget",
  noun: "widget",
  plural: "widgets",
  rerenderAfterEdit: "always",
  afterEditBytes: "plan",
} as const;

const apply = (log: ToolLog, plan: WritePlan, o: Partial<ApplyPlanOptions> & { commit: boolean }) =>
  applyPlan(log, plan, { ...BINDING, ...o });

/** One `index` call: the commit it builds on and the B body and event count it saw. */
interface Render {
  readonly history: string | null;
  readonly body: string | null;
  readonly events: number;
}
const textOf = (c: Render) => `body: ${c.body}events: ${c.events}\n`;

/** An index render that records what it saw and renders B's body and the event count. */
function recorder(): { calls: Render[]; index: IndexRender } {
  const calls: Render[] = [];
  const index: IndexRender = async (tree: TreeReader, history) => {
    const body = await tree.read(bodyOf(B));
    const events = (await tree.list("log/events")).filter((e) => e.path.endsWith(".yaml")).length;
    const call = { history, body: body === null ? null : decoder.decode(body), events };
    calls.push(call);
    return textOf(call);
  };
  return { calls, index };
}

/** A one-line message as `compose` renders it. */
const rendered = (message: string): RenderedCommit => ({
  message,
  subject: message,
  shortened: false,
  note: null,
});

const commitMessage = async (r: TempRepo) => (await out(r, ["log", "-1", "--format=%B"])).trim();

describe("applyPlan", () => {
  it("needs a message or compose to commit, and takes only one", async () => {
    const { log } = await setup();
    await expect(apply(log, newPlan(), { commit: true })).rejects.toThrow(
      new InvalidArgumentError("applyPlan needs a message to commit"),
    );
    const compose = () => rendered("m");
    await expect(apply(log, newPlan(), { commit: false, message: "m", compose })).rejects.toThrow(
      new InvalidArgumentError("applyPlan takes a message or compose, not both"),
    );
  });

  it("refuses a commit whose scope has an unstaged path, before writing", async () => {
    const { r, log } = await setup();
    await r.write(bodyOf(A), "# Changed\n");
    await expect(apply(log, notePlan(), { commit: true, message: "m" })).rejects.toThrow(
      new UsageError(
        `${bodyOf(A)} has unstaged changes; stage or discard them, or run without --commit`,
      ),
    );
    expect(await staged(r)).toEqual([]);
    expect(await out(r, ["ls-files", "--others", "--exclude-standard"])).toBe("");
  });

  it("refuses a commit whose scope has an untracked event file, and ignores other files there", async () => {
    const { r, log } = await setup();
    await r.write(`${eventDir(layout, A)}/notes.txt`, "x\n");
    const stray = eventPath(layout, ev(A, "noted", 9));
    await r.write(stray, serializeEvent(ev(A, "noted", 9)));
    await expect(apply(log, notePlan(), { commit: true, message: "m" })).rejects.toThrow(
      new UsageError(`${stray} is not tracked; git add it, or run without --commit`),
    );
    await r.remove(stray);
    const done = await apply(log, notePlan(), { commit: true, message: "m" });
    expect(done.commit).toBe(await head(r));
  });

  it("writes and stages without committing, reporting replaced, new and index paths in order", async () => {
    const { r, log } = await setup();
    const { calls, index } = recorder();
    const plan = newPlan({
      replace: { [bodyOf(A)]: { bytes: bytes("# Gear 2\n"), expected: bytes("# Gear\n") } },
      stage: [bodyOf(A), ...newPlan().stage],
    });
    const before = await head(r);
    const done = await apply(log, plan, { commit: false, index });
    expect(done).toEqual({
      written: [bodyOf(A), bodyOf(B), eventPath(layout, ev(B, "created", 1)), INDEX],
      commit: null,
      findings: [],
      notes: [],
      rendered: null,
    });
    expect(await head(r)).toBe(before);
    expect(await work(r, bodyOf(A))).toBe("# Gear 2\n");
    expect(await staged(r)).toEqual(
      [bodyOf(A), bodyOf(B), eventPath(layout, ev(B, "created", 1)), INDEX].sort(),
    );
    expect(calls).toEqual([{ history: before, body: "# Planned\n", events: 2 }]);
    expect(await work(r, INDEX)).toBe(textOf(calls[0] as Render));
  });

  it("restores the replaced files and the index and removes new files when a write fails", async () => {
    const { r, log } = await setup({ [INDEX]: "old index\n" });
    const { index } = recorder();
    const bad = { ...ev(B, "created", 1), data: {} };
    const plan = newPlan({
      replace: { [bodyOf(A)]: { bytes: bytes("# Gear 2\n"), expected: bytes("# Gear\n") } },
      files: { [bodyOf(B)]: bytes("# Planned\n"), ...fileOf(bad) },
      events: [bad],
    });
    await expect(apply(log, plan, { commit: false, index })).rejects.toThrow(InvalidArgumentError);
    expect(await work(r, bodyOf(A))).toBe("# Gear\n");
    await expect(work(r, bodyOf(B))).rejects.toThrow(/ENOENT/);
    expect(await work(r, INDEX)).toBe("old index\n");
    expect(await staged(r)).toEqual([]);
  });

  it("commits the plan's events and the scope's staged ones with deduplicated trailers", async () => {
    const { r, log } = await setup();
    const sameType = ev(A, "noted", 3);
    const other = ev(A, "retired", 4);
    await r.writeFiles({ ...fileOf(sameType), ...fileOf(other) });
    await r.stage(eventPath(layout, sameType), eventPath(layout, other));
    const plan = notePlan({ trailers: [["X", "ignored with events"]] });
    const done = await apply(log, plan, { commit: true, message: "note A" });
    expect(done.commit).toBe(await head(r));
    expect(await commitMessage(r)).toBe(
      ["note A", "", `W: ${A}`, "W-Event: noted", `W: ${A}`, "W-Event: retired"].join("\n"),
    );
    expect(
      (await out(r, ["show", "--name-only", "--format=", "HEAD"])).split("\n").filter((l) => l),
    ).toEqual(
      [
        eventPath(layout, ev(A, "noted", 2)),
        eventPath(layout, sameType),
        eventPath(layout, other),
      ].sort(),
    );
  });

  it("takes the plan's trailers without events, unless a staged event names the subject", async () => {
    const { r, log } = await setup();
    const edit = (): WritePlan => ({
      subject: A,
      files: {},
      replace: { [bodyOf(A)]: { bytes: bytes("# Gear 2\n"), expected: bytes("# Gear\n") } },
      events: [],
      stage: [bodyOf(A)],
      commitScope: [bodyOf(A), eventDir(layout, A)],
      eventDirs: [eventDir(layout, A)],
      trailers: [["W", A]],
      findings: [],
    });
    await apply(log, edit(), { commit: true, message: "edit A" });
    expect(await commitMessage(r)).toBe(`edit A\n\nW: ${A}`);

    await r.write(bodyOf(A), "# Gear\n");
    const noted = ev(A, "noted", 5);
    await r.writeFiles(fileOf(noted));
    await r.stage(eventPath(layout, noted));
    const again = {
      ...edit(),
      replace: { [bodyOf(A)]: { bytes: bytes("# Gear 3\n"), expected: bytes("# Gear\n") } },
    };
    await r.stage(bodyOf(A));
    await apply(log, again, { commit: true, message: "edit A again" });
    expect(await commitMessage(r)).toBe(`edit A again\n\nW: ${A}\nW-Event: noted`);
  });

  it("commits with compose's message, from the plan's and the extra events", async () => {
    const { r, log } = await setup();
    const extra = ev(A, "retired", 4);
    await r.writeFiles(fileOf(extra));
    await r.stage(eventPath(layout, extra));
    const seen: ComposeInput[] = [];
    const done = await apply(log, notePlan(), {
      commit: true,
      compose: async (c) => {
        seen.push(c);
        return rendered("composed");
      },
    });
    expect(seen.map(({ plan, extra }) => ({ plan, extra }))).toEqual([
      { plan: [{ subject: A, type: "noted" }], extra: [{ subject: A, type: "retired" }] },
    ]);
    expect(done.rendered).toEqual(rendered("composed"));
    expect((await commitMessage(r)).split("\n")[0]).toBe("composed");
  });

  it("widens the commit scope with `scope`, which runs first and only when committing", async () => {
    const { r, log } = await setup();
    await r.write(bodyOf(A), "# Changed\n");
    const narrow = notePlan({ commitScope: [eventDir(layout, A)] });
    const wide = async () => ({
      scope: [bodyOf(A), eventDir(layout, A)],
      eventDirs: [eventDir(layout, A)],
    });
    await expect(apply(log, narrow, { commit: true, message: "m", scope: wide })).rejects.toThrow(
      `${bodyOf(A)} has unstaged changes`,
    );
    const failing = async (): Promise<never> => {
      throw new UsageError("no description");
    };
    await expect(
      apply(log, narrow, { commit: true, message: "m", scope: failing }),
    ).rejects.toThrow(new UsageError("no description"));

    const scopes: (readonly string[])[] = [];
    const afterStage = async (scope: readonly string[]): Promise<AfterStage> => {
      scopes.push(scope);
      return { findings: null, commit: true };
    };
    await r.stage(bodyOf(A));
    const done = await apply(log, narrow, { commit: true, message: "m", scope: wide, afterStage });
    expect(scopes).toEqual([[bodyOf(A), eventDir(layout, A)]]);
    expect(
      (await out(r, ["show", "--name-only", "--format=", "HEAD"])).split("\n").filter((l) => l),
    ).toEqual([bodyOf(A), eventPath(layout, ev(A, "noted", 2))].sort());
    expect(done.commit).toBe(await head(r));

    const { log: other } = await setup();
    await apply(other, newPlan(), { commit: false, scope: failing, afterStage });
    expect(scopes[1]).toEqual(newPlan().commitScope);
  });

  it("leaves the files written and staged when afterStage turns the commit off", async () => {
    const { r, log } = await setup();
    const { calls, index } = recorder();
    const before = await head(r);
    const lint = finding({ rule: "body/lint", severity: "warning", message: "lint" });
    const done = await apply(log, newPlan(), {
      commit: true,
      message: "m",
      index,
      afterStage: async () => {
        await r.write(bodyOf(B), "# Edited\n");
        await r.stage(bodyOf(B));
        return { findings: [lint], commit: false };
      },
    });
    expect(done.commit).toBeNull();
    expect(done.findings).toEqual([lint]);
    expect(await head(r)).toBe(before);
    expect(calls).toEqual([
      { history: before, body: "# Planned\n", events: 2 },
      { history: before, body: "# Edited\n", events: 2 },
    ]);
    expect(await work(r, INDEX)).toBe(textOf(calls[1] as Render));
    expect(await out(r, ["show", `:${INDEX}`])).toBe(textOf(calls[1] as Render));
  });

  it("throws CommitFailedError with the notes so far and WRITE_RERUN when git commit fails", async () => {
    const { r, log } = await setup();
    const hook = join(r.root, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    const err = await apply(log, newPlan(), {
      commit: true,
      message: "m",
      index: async () => null,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommitFailedError);
    const failed = err as CommitFailedError;
    expect(failed.rerun).toBe(WRITE_RERUN);
    expect(failed.message).toContain(WRITE_RERUN);
    expect(failed.notes).toEqual([
      `${INDEX} not updated: numbers need history in this shallow clone; run git fetch --unshallow, then widget index`,
    ]);
  });

  it("throws CommitFailedError with the before hint when the render after the editor step fails", async () => {
    const { log } = await setup();
    let n = 0;
    const err = await apply(log, newPlan(), {
      commit: true,
      message: "m",
      index: async () => {
        n += 1;
        if (n > 1) throw new Error("boom");
        return "index\n";
      },
      afterStage: async () => ({ findings: null, commit: true }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommitFailedError);
    const { message } = err as CommitFailedError;
    expect(message.split("\n")[0]).toBe(`${INDEX} couldn't be refreshed: boom`);
    expect(message).toContain(indexBeforeHint("widget", "widgets", "log"));
  });
});

describe("applyPlan's render after the editor step", () => {
  /**
   * The editor step rewrites B's staged body in the work tree, and with `stageEvent` stages
   * another event of B, which changes the staged events the commit takes.
   */
  async function run(
    rerenderAfterEdit: "always" | "when-events-change",
    afterEditBytes: "plan" | "worktree",
    stageEvent: boolean,
  ) {
    const { r, log } = await setup();
    const { calls, index } = recorder();
    const trees: (string | null)[] = [];
    const before = await head(r);
    const done = await applyPlan(log, newPlan(), {
      ...BINDING,
      rerenderAfterEdit,
      afterEditBytes,
      commit: true,
      index,
      compose: async (c) => {
        const body = await c.tree.read(bodyOf(B));
        trees.push(body === null ? null : decoder.decode(body));
        return rendered("new B");
      },
      afterStage: async () => {
        await r.write(bodyOf(B), "# Edited\n");
        if (stageEvent) {
          const noted = ev(B, "noted", 6);
          await r.writeFiles(fileOf(noted));
          await r.stage(eventPath(layout, noted));
        }
        return { findings: null, commit: true };
      },
    });
    const committed = await out(r, ["show", `HEAD:${INDEX}`]);
    return { before, done, calls, trees, committed };
  }

  for (const rerenderAfterEdit of ["always", "when-events-change"] as const) {
    for (const afterEditBytes of ["plan", "worktree"] as const) {
      for (const stageEvent of [false, true]) {
        const events = stageEvent ? "changed" : "unchanged";
        it(`${rerenderAfterEdit}, ${afterEditBytes} bytes, staged events ${events}`, async () => {
          const { before, done, calls, trees, committed } = await run(
            rerenderAfterEdit,
            afterEditBytes,
            stageEvent,
          );
          const body = afterEditBytes === "plan" ? "# Planned\n" : "# Edited\n";
          const count = stageEvent ? 3 : 2;
          const step1 = { history: before, body: "# Planned\n", events: 2 };
          const step4 = { history: before, body, events: count };
          const step5 = { history: done.commit, body: "# Edited\n", events: count };
          const rerender = rerenderAfterEdit === "always" || stageEvent;
          expect(trees).toEqual([body]);
          expect(calls).toEqual(rerender ? [step1, step4, step5] : [step1, step5]);
          expect(committed).toBe(textOf(rerender ? step4 : step1));
          expect(done.written).toContain(INDEX);
        });
      }
    }
  }
});

describe("unstagedIndexNote", () => {
  const words = { tool: "widget", noun: "widget" };

  it("names the unstaged files when only the work tree's render matches the staged index", async () => {
    const { r, log } = await setup();
    await r.write(bodyOf(A), "# Changed\n");
    const own = async () => "own\n";
    expect(await unstagedIndexNote(log, INDEX, "staged\n", null, own, words)).toBe(
      `${unstagedIndexText(INDEX, [bodyOf(A)], "widget")}; git add them before you commit, or move them out of the work tree and run widget index`,
    );
    expect(await unstagedIndexNote(log, INDEX, "own\n", null, own, words)).toBeNull();
    const failing = async (): Promise<never> => {
      throw new Error("boom");
    };
    expect(await unstagedIndexNote(log, INDEX, "staged\n", null, failing, words)).toBeNull();
  });

  it("is null without unstaged log files", async () => {
    const { log } = await setup();
    expect(
      await unstagedIndexNote(log, INDEX, "staged\n", null, async () => "own\n", words),
    ).toBeNull();
  });
});
