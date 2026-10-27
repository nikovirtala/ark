import { afterEach, describe, expect, it } from "vitest";
import { compileKind } from "../envelope/kind.js";
import type { EventEnvelope } from "../envelope/types.js";
import { serializeEvent } from "../envelope/yaml.js";
import type { Finding } from "../findings/finding.js";
import { MemoryTree } from "../git/tree.js";
import { eventPath } from "../identity/layout.js";
import { createUlidFactory } from "../identity/ulid.js";
import { defineKind, eventType } from "../kind/define.js";
import { exampleMachineKind } from "../testing/example-machine-kind.js";
import { TEST_HUMAN } from "../testing/history.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import type { Check, CheckContext } from "../verify/checks.js";
import { type VerifyMode, verifyLog, verifySnapshots } from "../verify/verify.js";
import {
  anchorCheck,
  type GovernedChange,
  governedChanges,
  type NarrowedScope,
  narrowedScopes,
  scopeGlobCheck,
} from "./checks.js";
import { setEventType } from "./set.js";

/** A scoped kind without `relate`: globs must match while open or done. */
const task = defineKind({
  name: "task",
  schema: "task/v1",
  states: ["open", "done", "dropped"],
  events: {
    opened: eventType()({ data: { type: "object" }, allowedIn: [], to: "open" }),
    labeled: setEventType({
      item: { type: "string" },
      maxItems: 10,
      allowedIn: ["open", "done", "dropped"],
    }),
    done: eventType()({ data: { type: "object" }, allowedIn: ["open"], to: "done" }),
    dropped: eventType()({ data: { type: "object" }, allowedIn: ["open", "done"], to: "dropped" }),
  },
  initial: "opened",
  reduce: () => null,
  project: (s) => s.id,
  body: "none",
  layout: { bodies: null, events: "events" },
  defaultRoot: "tasks",
  options: undefined,
  scope: { event: "labeled", activeIn: ["open", "done"] },
});
const layout = task.layoutAt("tasks");

const A = "a7c2m9xd";
const B = "b8d3n0ye";
const C = "c9e4p1zf";
const MISSING = "zzzzzzzz";

let ms = Date.parse("2026-01-01T00:00:00Z");
const ulid = createUlidFactory({ now: () => ms });
function ev(subject: string, type: string, data: Record<string, unknown> = {}): EventEnvelope {
  ms += 1000;
  return {
    envelope: "ledger/v1",
    kind: "task",
    schema: "task/v1",
    id: ulid(),
    subject,
    type,
    at: new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"),
    actor: TEST_HUMAN,
    data,
  };
}
const files = (...events: EventEnvelope[]) =>
  Object.fromEntries(events.map((e) => [eventPath(layout, e), serializeEvent(e)]));

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(initial: Record<string, string> = { "README.md": "# r\n" }) {
  const r = await createTempRepo({ files: initial });
  repos.push(r);
  return r;
}
async function commitFiles(r: TempRepo, f: Record<string, string>, message = "add") {
  await r.writeFiles(f);
  await r.stage(...Object.keys(f));
  return r.commit(message);
}

const CHECKS = [scopeGlobCheck(), anchorCheck({ keyword: "task", exclude: ["docs/**"] })];
const verify = (r: TempRepo, mode: VerifyMode, checks: readonly Check[] = CHECKS) =>
  verifyLog({ git: r.git, kind: task, layout, mode, checks });
const brief = (fs: readonly Finding[]) => fs.map((f) => [f.rule, f.file, f.line, f.subject]);

/** A check that records what `f` returns for each context. */
function probe<T>(f: (ctx: CheckContext) => Promise<T>): { check: Check; seen: T[] } {
  const seen: T[] = [];
  return {
    seen,
    check: {
      id: "probe",
      async run(ctx) {
        seen.push(await f(ctx));
        return [];
      },
    },
  };
}

describe("scopeGlobCheck", () => {
  it("reports an unmatched glob in staged, range and full mode until a file matches", async () => {
    const r = await repo();
    await r.checkout("topic", { create: true });
    const opened = ev(A, "opened");
    const labeled = ev(A, "labeled", { set: ["src/**"] });
    const f = files(opened, labeled);
    await r.writeFiles(f);
    await r.stage(...Object.keys(f));
    const expected = [["scope/glob-unmatched", eventPath(layout, labeled), null, A]];
    const staged = await verify(r, { type: "staged" });
    expect(brief(staged)).toEqual(expected);
    expect(staged[0]?.message).toBe('scope glob "src/**" matches no tracked file');
    await r.commit("label");
    expect(brief(await verify(r, { type: "range", base: "main", head: "topic" }))).toEqual(
      expected,
    );
    expect(brief(await verify(r, { type: "full", head: "topic" }))).toEqual(expected);
    expect(brief(await verify(r, { type: "full" }))).toEqual(expected);

    await commitFiles(r, { "src/a.ts": "export {};\n" });
    expect(await verify(r, { type: "range", base: "main", head: "topic" })).toEqual([]);
    expect(await verify(r, { type: "full" })).toEqual([]);
    // Deleted from the work tree: the work tree no longer has a match, the commit still does.
    await r.remove("src/a.ts");
    expect(brief(await verify(r, { type: "full" }))).toEqual(expected);
    expect(await verify(r, { type: "full", head: "HEAD" })).toEqual([]);
  });

  it("reports invalid globs in any status and unmatched ones only while active", async () => {
    const r = await repo();
    const [openedA, openedB] = [ev(A, "opened"), ev(B, "opened")];
    const invalid = ev(A, "labeled", { set: ["nothing/**", "{a,{b}}"] });
    const active = ev(B, "labeled", { set: ["{a,{b}}"] });
    await commitFiles(r, files(openedA, openedB, invalid, active, ev(A, "dropped")));
    const findings = await verify(r, { type: "full" });
    expect(brief(findings)).toEqual([
      ["scope/glob-invalid", eventPath(layout, invalid), null, A],
      ["scope/glob-invalid", eventPath(layout, active), null, B],
    ]);
    expect(findings[0]?.message).toBe(
      'scope glob "{a,{b}}" is invalid: brace groups can\'t be nested',
    );
  });

  it("leaves untouched subjects to range and full mode in staged mode", async () => {
    const r = await repo();
    await commitFiles(r, files(ev(A, "opened"), ev(A, "labeled", { set: ["src/**"] })));
    const f = files(ev(B, "opened"), ev(B, "labeled", { set: ["README.md"] }));
    await r.writeFiles(f);
    await r.stage(...Object.keys(f));
    expect(await verify(r, { type: "staged" })).toEqual([]);
    expect(brief(await verify(r, { type: "full" })).map((x) => x[0])).toEqual([
      "scope/glob-unmatched",
    ]);
  });
});

describe("anchorCheck", () => {
  async function anchored() {
    const r = await repo({
      "README.md": "# r\n",
      "src/ok.ts": `// task:${A}\n`,
      "src/qualified.ts": `// task:platform:${MISSING}\n`,
      "docs/notes.md": `<!-- task:${MISSING} -->\n`,
      "tasks/README.md": `# task:${MISSING}\n`,
    });
    await commitFiles(r, files(ev(A, "opened")));
    return r;
  }

  it("is quiet for existing, qualified, excluded and in-log anchors", async () => {
    const r = await anchored();
    expect(await verify(r, { type: "full" })).toEqual([]);
    expect(await verify(r, { type: "full", head: "HEAD" })).toEqual([]);
  });

  it("reports an anchor naming no subject in staged, range and full mode", async () => {
    const r = await anchored();
    await r.checkout("topic", { create: true });
    await r.write("src/bad.ts", `export {};\n// task:${MISSING}\n`);
    await r.stage("src/bad.ts");
    const expected = [["scope/anchor-missing", "src/bad.ts", 2, MISSING]];
    const staged = await verify(r, { type: "staged" });
    expect(brief(staged)).toEqual(expected);
    expect(staged[0]?.message).toBe(`anchor task:${MISSING} names no task in this log`);
    await r.commit("bad anchor");
    expect(brief(await verify(r, { type: "range", base: "main", head: "topic" }))).toEqual(
      expected,
    );
    expect(brief(await verify(r, { type: "full", head: "topic" }))).toEqual(expected);
    expect(brief(await verify(r, { type: "full" }))).toEqual(expected);
    // Staged mode scans only the changed files.
    await r.write("src/other.ts", "export {};\n");
    await r.stage("src/other.ts");
    expect(await verify(r, { type: "staged" })).toEqual([]);
    // A widened staged run (a checked input outside the log changed) scans the whole tree.
    await r.write("task.toml", "x = 1\n");
    await r.stage("task.toml");
    expect(
      brief(
        await verifyLog({
          git: r.git,
          kind: task,
          layout,
          mode: { type: "staged" },
          checks: CHECKS,
          widenOn: ["task.toml"],
        }),
      ),
    ).toEqual(expected);
  });

  it("is quiet without a repository context or a scoped kind", async () => {
    const tree = new MemoryTree({
      ...files(ev(A, "opened"), ev(A, "labeled", { set: ["src/**"] })),
      "src/bad.ts": `// task:${MISSING}\n`,
    });
    expect(
      await verifySnapshots({
        kind: compileKind(task),
        layout,
        base: null,
        head: tree,
        scope: "all",
        checks: CHECKS,
      }),
    ).toEqual([]);
    const r = await repo({ "src/bad.ts": `// widget:${MISSING}\n` });
    const widgets = await verifyLog({
      git: r.git,
      kind: exampleMachineKind,
      layout: exampleMachineKind.layoutAt("log"),
      mode: { type: "full" },
      checks: [scopeGlobCheck(), anchorCheck({ keyword: "widget", exclude: [] })],
    });
    expect(widgets).toEqual([]);
  });
});

describe("governedChanges", () => {
  it("finds changes governed by untouched subjects in staged mode for a kind without relate", async () => {
    const r = await repo({
      "README.md": "# r\n",
      "src/a.ts": "a\n",
      "lib/b.ts": `// task:${B}\n`,
    });
    await commitFiles(r, {
      ...files(ev(A, "opened"), ev(A, "labeled", { set: ["src/**"] }), ev(A, "dropped")),
      ...files(ev(B, "opened"), ev(B, "done")),
    });
    await r.write("src/a.ts", "changed\n");
    await r.write("lib/b.ts", `// task:${B}\nchanged\n`);
    const f = files(ev(C, "opened"));
    await r.writeFiles(f);
    await r.stage("src/a.ts", "lib/b.ts", ...Object.keys(f));
    const p = probe(async (ctx) => ({
      folded: [...(ctx.folded?.head.subjects.keys() ?? [])],
      inactive: await governedChanges(ctx, {
        keyword: "task",
        exclude: [],
        statuses: ["done", "dropped"],
      }),
      open: await governedChanges(ctx, { keyword: "task", exclude: [], statuses: ["open"] }),
    }));
    await verify(r, { type: "staged" }, [p.check]);
    const inactive: GovernedChange[] = [
      { path: "lib/b.ts", subject: B, status: "done", via: [{ type: "anchor", line: 1 }] },
      { path: "src/a.ts", subject: A, status: "dropped", via: [{ type: "glob", glob: "src/**" }] },
    ];
    // The fold holds only the touched subject; the helper folds the head itself.
    expect(p.seen).toEqual([{ folded: [C], inactive, open: [] }]);

    await r.commit("change");
    p.seen.length = 0;
    await verify(r, { type: "range", base: "HEAD~1", head: "HEAD" }, [p.check]);
    expect(p.seen[0]?.inactive).toEqual(inactive);
    p.seen.length = 0;
    await verify(r, { type: "full" }, [p.check]);
    expect(p.seen[0]?.inactive).toEqual([]);
  });
});

describe("narrowedScopes", () => {
  async function labeledRepo() {
    const r = await repo({ "README.md": "# r\n", "src/a.ts": "a\n", "src/b.ts": "b\n" });
    await commitFiles(
      r,
      files(ev(A, "opened"), ev(A, "labeled", { set: ["src/**"] }), ev(A, "done")),
    );
    return r;
  }
  const narrowed = () =>
    probe(async (ctx) => ({
      done: await narrowedScopes(ctx, { statuses: ["done"] }),
      open: await narrowedScopes(ctx, { statuses: ["open"] }),
    }));

  it("reports files the new set stops covering", async () => {
    const r = await labeledRepo();
    const relabeled = ev(A, "labeled", { set: ["src/a.ts"] });
    const f = files(relabeled);
    await r.writeFiles(f);
    await r.stage(...Object.keys(f));
    const p = narrowed();
    await verify(r, { type: "staged" }, [p.check]);
    const done: NarrowedScope[] = [
      { subject: A, file: eventPath(layout, relabeled), lost: ["src/b.ts"] },
    ];
    expect(p.seen).toEqual([{ done, open: [] }]);
    await r.commit("narrow");
    p.seen.length = 0;
    await verify(r, { type: "range", base: "HEAD~1", head: "HEAD" }, [p.check]);
    await verify(r, { type: "full" }, [p.check]);
    expect(p.seen).toEqual([
      { done, open: [] },
      { done: [], open: [] },
    ]);
  });

  it("ignores a moved file", async () => {
    const r = await labeledRepo();
    await r.git.run(["mv", "src/b.ts", "lib-b.ts"]);
    const f = files(ev(A, "labeled", { set: ["lib-b.ts", "src/a.ts"] }));
    await r.writeFiles(f);
    await r.stage(...Object.keys(f));
    const p = narrowed();
    await verify(r, { type: "staged" }, [p.check]);
    expect(p.seen).toEqual([{ done: [], open: [] }]);
  });
});
