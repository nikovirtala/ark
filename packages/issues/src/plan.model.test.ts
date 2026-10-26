import { type EventEnvelope, eventPath, UsageError } from "@nikovirtala/ledger";
import { TEST_HUMAN } from "@nikovirtala/ledger/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { labelPrefix } from "./kind.js";
import {
  type PlanResult,
  planClose,
  planComment,
  planLink,
  planOpen,
  planReopen,
  planSet,
  planStart,
  planStop,
  planUnlink,
} from "./plan.js";
import { arbReason, arbTitle, ISSUE_TEST_OPTIONS, LABEL_POOL } from "./test-support/arbitraries.js";
import { LAYOUT } from "./test-support/events.js";
import { arbIssueHistory, type IssueHistory } from "./test-support/history.js";
import { referenceModel } from "./test-support/oracle.js";
import { MemoryLog } from "./test-support/plans.js";

type Step = IssueHistory["steps"][number];
const EXCLUSIVE = ISSUE_TEST_OPTIONS.exclusive;
const UNKNOWN = "zzzzzzzz";
const ME = TEST_HUMAN;

/** The model: every event written so far, and the subjects in creation order. */
interface Model {
  steps: Step[];
  subjects: string[];
}

/** A command's candidate events as the model expects them, or `"usage"` for an exit-2 input. */
type Candidate =
  | readonly { type: string; data: Record<string, unknown>; reason?: string }[]
  | "usage";

const pick = (m: Model, i: number) => (i < m.subjects.length ? (m.subjects[i] as string) : UNKNOWN);

abstract class IssueCommand implements fc.AsyncCommand<Model, MemoryLog> {
  abstract readonly name: string;
  abstract subject(m: Model): string;
  /** What the model expects the command to write, given the model's current issues. */
  abstract candidate(m: Model, now: ReturnType<typeof referenceModel>["models"]): Candidate;
  abstract plan(log: MemoryLog, m: Model): Promise<PlanResult>;

  check(): boolean {
    return true;
  }

  async run(m: Model, log: MemoryLog): Promise<void> {
    const { models } = referenceModel(m.steps, { exclusive: EXCLUSIVE });
    const subject = this.subject(m);
    const want = subject === UNKNOWN ? "usage" : this.candidate(m, models);
    const before = await log.read();
    let r: PlanResult;
    try {
      r = await this.plan(log, m);
    } catch (err) {
      expect(err, this.toString()).toBeInstanceOf(UsageError);
      expect(want, this.toString()).toBe("usage");
      return;
    }
    expect(want, `${this.toString()} wasn't a usage error`).not.toBe("usage");
    if (want === "usage") return;
    const at = new Date(
      Math.max(...m.steps.map((s) => Date.parse(s.event.at)), Date.parse("2001-01-01T00:00:00Z")) +
        500,
    )
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    const extra: Step[] = want.map((w, i) => {
      const event = {
        ...(m.steps[0]?.event as EventEnvelope),
        id: `7ZZZZZZZZZZZZZZZZZZZZZZZ${String(i).padStart(2, "0")}`,
        subject,
        type: w.type,
        at,
        ...(w.reason === undefined ? {} : { reason: w.reason }),
        data: w.data,
      } as EventEnvelope;
      return { subject, path: eventPath(LAYOUT, event), event };
    });
    const { lines } = referenceModel([...m.steps, ...extra], { exclusive: EXCLUSIVE });
    expect(r.ok, `${this.toString()}: ${JSON.stringify(lines)}`).toBe(lines.length === 0);
    if (!r.ok) {
      expect((await log.read()).projection).toEqual(before.projection);
      return;
    }
    expect(r.plan.events.map((e) => [e.type, e.data])).toEqual(want.map((w) => [w.type, w.data]));
    log.apply(r.plan);
    for (const event of r.plan.events)
      m.steps.push({ subject, path: eventPath(LAYOUT, event), event });
    const after = await log.read();
    const ref = referenceModel(m.steps, { exclusive: EXCLUSIVE }).models.get(subject);
    const v = after.projection.views.get(subject);
    expect(v?.state).toBe(ref?.state);
    expect(v?.resolution).toBe(ref?.resolution);
    expect(v?.duplicate_of ?? null).toBe(
      ref?.state === "closed" ? (ref?.duplicateOf ?? null) : null,
    );
    expect(after.folded.subjects.get(subject)?.state?.links.map((l) => [l.to, l.rel])).toEqual(
      ref?.links.map((l) => [l.to, l.rel]),
    );
    expect(v?.labels).toEqual(ref?.labels);
    expect(v?.assignees).toEqual(ref?.assignees);
    expect(v?.applies_to).toEqual(ref?.appliesTo);
    expect(after.findings.filter((f) => f.severity === "error")).toEqual([]);
  }
}

class Start extends IssueCommand {
  readonly name = "start";
  readonly i: number;
  constructor(i: number) {
    super();
    this.i = i;
  }
  subject = (m: Model) => pick(m, this.i);
  candidate(m: Model, models: ReturnType<typeof referenceModel>["models"]): Candidate {
    const s = models.get(this.subject(m));
    return s?.assignees.length === 0
      ? [
          { type: "started", data: {} },
          { type: "assigned", data: { set: [ME.email ?? ""] } },
        ]
      : [{ type: "started", data: {} }];
  }
  plan(log: MemoryLog, m: Model) {
    return run(log, (read, c) => planStart(read, { id: this.subject(m), actor: ME }, c));
  }
  toString = () => `start(${this.i})`;
}

class Stop extends IssueCommand {
  readonly name = "stop";
  readonly i: number;
  constructor(i: number) {
    super();
    this.i = i;
  }
  subject = (m: Model) => pick(m, this.i);
  candidate = (): Candidate => [{ type: "stopped", data: {} }];
  plan(log: MemoryLog, m: Model) {
    return run(log, (read, c) => planStop(read, { id: this.subject(m), actor: ME }, c));
  }
  toString = () => `stop(${this.i})`;
}

class Close extends IssueCommand {
  readonly name = "close";
  readonly i: number;
  readonly resolution: "done" | "wontfix" | "obsolete" | "duplicate";
  readonly of: number;
  readonly reason: string | null;
  constructor(
    i: number,
    resolution: "done" | "wontfix" | "obsolete" | "duplicate",
    of: number,
    reason: string | null,
  ) {
    super();
    this.i = i;
    this.resolution = resolution;
    this.of = of;
    this.reason = reason;
  }
  subject = (m: Model) => pick(m, this.i);
  candidate(m: Model): Candidate {
    if (this.resolution !== "duplicate") {
      return [
        {
          type: "closed",
          data: { resolution: this.resolution },
          ...(this.reason === null ? {} : { reason: this.reason.trim() }),
        },
      ];
    }
    const of = pick(m, this.of);
    if (of === UNKNOWN || of === this.subject(m)) return "usage";
    return [
      {
        type: "closed",
        data: { resolution: "duplicate", of },
        ...(this.reason === null ? {} : { reason: this.reason.trim() }),
      },
    ];
  }
  plan(log: MemoryLog, m: Model) {
    return run(log, (read, c) =>
      planClose(
        read,
        {
          id: this.subject(m),
          ...(this.resolution === "duplicate"
            ? { of: pick(m, this.of) }
            : { resolution: this.resolution }),
          reason: this.reason,
          actor: ME,
        },
        c,
      ),
    );
  }
  toString = () =>
    `close(${this.i}, ${this.resolution}, ${this.of}, ${JSON.stringify(this.reason)})`;
}

class Reopen extends IssueCommand {
  readonly name = "reopen";
  readonly i: number;
  readonly reason: string;
  constructor(i: number, reason: string) {
    super();
    this.i = i;
    this.reason = reason;
  }
  subject = (m: Model) => pick(m, this.i);
  candidate = (): Candidate => [{ type: "reopened", data: {}, reason: this.reason.trim() }];
  plan(log: MemoryLog, m: Model) {
    return run(log, (read, c) =>
      planReopen(read, { id: this.subject(m), reason: this.reason, actor: ME }, c),
    );
  }
  toString = () => `reopen(${this.i})`;
}

class Link extends IssueCommand {
  readonly name = "link";
  readonly i: number;
  readonly j: number;
  readonly rel: "depends-on" | "part-of" | "relates-to";
  readonly remove: boolean;
  constructor(i: number, j: number, rel: "depends-on" | "part-of" | "relates-to", remove: boolean) {
    super();
    this.i = i;
    this.j = j;
    this.rel = rel;
    this.remove = remove;
  }
  subject = (m: Model) => pick(m, this.i);
  candidate(m: Model, models: ReturnType<typeof referenceModel>["models"]): Candidate {
    const to = pick(m, this.j);
    if (to === UNKNOWN) return "usage";
    if (to === this.subject(m)) return this.remove ? [] : "usage";
    const has =
      models.get(this.subject(m))?.links.some((l) => l.to === to && l.rel === this.rel) ?? false;
    if (this.remove) return has ? [{ type: "unlinked", data: { to, rel: this.rel } }] : [];
    return has ? [] : [{ type: "linked", data: { to, rel: this.rel } }];
  }
  plan(log: MemoryLog, m: Model) {
    const input = { id: this.subject(m), to: pick(m, this.j), rel: this.rel, actor: ME };
    return run(log, (read, c) =>
      this.remove ? planUnlink(read, input, c) : planLink(read, input, c),
    );
  }
  toString = () => `${this.remove ? "unlink" : "link"}(${this.i}, ${this.j}, ${this.rel})`;
}

class Label extends IssueCommand {
  readonly name = "label";
  readonly i: number;
  readonly add: readonly string[];
  readonly remove: readonly string[];
  constructor(i: number, add: readonly string[], remove: readonly string[]) {
    super();
    this.i = i;
    this.add = add;
    this.remove = remove;
  }
  subject = (m: Model) => pick(m, this.i);
  candidate(m: Model, models: ReturnType<typeof referenceModel>["models"]): Candidate {
    if (this.add.length === 0 && this.remove.length === 0) return "usage";
    if (this.add.some((l) => this.remove.includes(l))) return "usage";
    const current = models.get(this.subject(m))?.labels ?? [];
    const prefixes = new Set(
      this.add.map(labelPrefix).filter((p) => p !== null && EXCLUSIVE.includes(p)),
    );
    const replaced = current.filter((l) => {
      const p = labelPrefix(l);
      return p !== null && prefixes.has(p) && !this.add.includes(l);
    });
    const gone = new Set([...this.remove, ...replaced]);
    const set = [...new Set([...current.filter((l) => !gone.has(l)), ...this.add])].sort();
    const same = set.length === current.length && set.every((x, k) => x === [...current].sort()[k]);
    return same ? [] : [{ type: "labeled", data: { set } }];
  }
  plan(log: MemoryLog, m: Model) {
    return run(log, (read, c) =>
      planSet(
        read,
        "label",
        { id: this.subject(m), op: { add: this.add, remove: this.remove }, actor: ME },
        c,
      ),
    );
  }
  toString = () => `label(${this.i}, +${this.add.join(",")}, -${this.remove.join(",")})`;
}

/** Pools for `assign` and `scope`: `me`, valid items and one invalid item each. */
const SET_POOLS = {
  assign: {
    items: ["me", ME.email ?? "", "alice@example.com", "bob@example.com", "a b"],
    invalid: ["a b"],
  },
  scope: { items: ["src/**", "docs/*.md", "**/*.ts", "["], invalid: ["["] },
} as const;

/** `assign` or `scope` with `set` (`[]` clears) or `add` and `remove`, as `applySetOp` decides. */
class SetCommand extends IssueCommand {
  readonly name: "assign" | "scope";
  readonly i: number;
  readonly op: { set?: readonly string[]; add?: readonly string[]; remove?: readonly string[] };
  constructor(
    name: "assign" | "scope",
    i: number,
    op: { set?: readonly string[]; add?: readonly string[]; remove?: readonly string[] },
  ) {
    super();
    this.name = name;
    this.i = i;
    this.op = op;
  }
  subject = (m: Model) => pick(m, this.i);
  candidate(m: Model, models: ReturnType<typeof referenceModel>["models"]): Candidate {
    const me = (xs: readonly string[] = []) =>
      xs.map((x) => (this.name === "assign" && x === "me" ? (ME.email ?? "") : x));
    const set = this.op.set === undefined ? undefined : me(this.op.set);
    const add = me(this.op.add);
    const remove = me(this.op.remove);
    if (set === undefined && add.length === 0 && remove.length === 0) return "usage";
    if (add.some((x) => remove.includes(x))) return "usage";
    const invalid: readonly string[] = SET_POOLS[this.name].invalid;
    if ((set ?? add).some((x) => invalid.includes(x))) return "usage";
    const s = models.get(this.subject(m));
    const current = [...((this.name === "assign" ? s?.assignees : s?.appliesTo) ?? [])].sort();
    const next = [
      ...new Set(set ?? [...current.filter((x) => !remove.includes(x)), ...add]),
    ].sort();
    const same = next.length === current.length && next.every((x, k) => x === current[k]);
    return same
      ? []
      : [{ type: this.name === "assign" ? "assigned" : "scoped", data: { set: next } }];
  }
  plan(log: MemoryLog, m: Model) {
    return run(log, (read, c) =>
      planSet(read, this.name, { id: this.subject(m), op: this.op, actor: ME }, c),
    );
  }
  toString = () => `${this.name}(${this.i}, ${JSON.stringify(this.op)})`;
}

const arbSetOp = (pool: readonly string[]) =>
  fc.oneof(
    fc.uniqueArray(fc.constantFrom(...pool), { maxLength: 2 }).map((set) => ({ set })),
    fc
      .tuple(
        fc.uniqueArray(fc.constantFrom(...pool), { maxLength: 2 }),
        fc.uniqueArray(fc.constantFrom(...pool), { maxLength: 1 }),
      )
      .map(([add, remove]) => ({ add, remove })),
  );

class Comment extends IssueCommand {
  readonly name = "comment";
  readonly i: number;
  constructor(i: number) {
    super();
    this.i = i;
  }
  subject = (m: Model) => pick(m, this.i);
  candidate = (): Candidate => [{ type: "commented", data: { text: "a comment" } }];
  plan(log: MemoryLog, m: Model) {
    return run(log, (read, c) =>
      planComment(read, { id: this.subject(m), text: "a comment", actor: ME }, c),
    );
  }
  toString = () => `comment(${this.i})`;
}

class Open implements fc.AsyncCommand<Model, MemoryLog> {
  readonly title: string;
  readonly parent: number;
  constructor(title: string, parent: number) {
    this.title = title;
    this.parent = parent;
  }
  check = () => true;
  async run(m: Model, log: MemoryLog): Promise<void> {
    const parent = this.parent < m.subjects.length ? pick(m, this.parent) : null;
    const r = await run(log, (read, c) =>
      planOpen(
        read,
        { title: this.title, parent, sections: { goal: "g", done: "d" }, actor: ME },
        c,
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.events.map((e) => [e.type, e.data.parent])).toEqual([
      ["opened", parent ?? undefined],
    ]);
    log.apply(r.plan);
    for (const event of r.plan.events) {
      m.steps.push({ subject: event.subject, path: eventPath(LAYOUT, event), event });
    }
    m.subjects.push(r.plan.subject);
    expect(referenceModel(m.steps, { exclusive: EXCLUSIVE }).lines).toEqual([]);
  }
  toString = () => `open(${JSON.stringify(this.title)}, ${this.parent})`;
}

async function run(
  log: MemoryLog,
  f: (
    read: Awaited<ReturnType<MemoryLog["read"]>>,
    c: ReturnType<MemoryLog["context"]>,
  ) => Promise<PlanResult>,
): Promise<PlanResult> {
  const read = await log.read();
  return f(read, log.context(read));
}

const index = fc.nat({ max: 8 });
const commands = [
  index.map((i) => new Start(i)),
  index.map((i) => new Stop(i)),
  fc
    .tuple(
      index,
      fc.constantFrom(
        "done" as const,
        "wontfix" as const,
        "obsolete" as const,
        "duplicate" as const,
      ),
      index,
      fc.option(arbReason, { nil: null }),
    )
    .map(([i, r, of, reason]) => new Close(i, r, of, reason)),
  fc.tuple(index, arbReason).map(([i, reason]) => new Reopen(i, reason)),
  fc
    .tuple(
      index,
      index,
      fc.constantFrom("depends-on" as const, "part-of" as const, "relates-to" as const),
      fc.boolean(),
    )
    .map(([i, j, rel, remove]) => new Link(i, j, rel, remove)),
  fc
    .tuple(
      index,
      fc.uniqueArray(fc.constantFrom(...LABEL_POOL), { maxLength: 2 }),
      fc.uniqueArray(fc.constantFrom(...LABEL_POOL), { maxLength: 1 }),
    )
    .map(([i, add, remove]) => new Label(i, add, remove)),
  index.map((i) => new Comment(i)),
  fc
    .tuple(index, arbSetOp(SET_POOLS.assign.items))
    .map(([i, op]) => new SetCommand("assign", i, op)),
  fc.tuple(index, arbSetOp(SET_POOLS.scope.items)).map(([i, op]) => new SetCommand("scope", i, op)),
  fc.tuple(arbTitle, index).map(([t, p]) => new Open(t, p)),
];

describe("lifecycle model", () => {
  it("matches the reference model after every command, and refused commands write nothing", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbIssueHistory(),
        fc.commands(commands, { maxCommands: 25 }),
        async (h, cmds) => {
          const latest = Math.max(...h.steps.map((s) => Date.parse(s.event.at)));
          const log = new MemoryLog(h.files, { issues: { exclusive: EXCLUSIVE }, clock: latest });
          const model: Model = { steps: [...h.steps], subjects: h.subjects.map((s) => s.id) };
          await fc.asyncModelRun(() => ({ model, real: log }), cmds);
        },
      ),
      { numRuns: 200, endOnFailure: true },
    );
  }, 300_000);
});
