import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, UsageError } from "../errors.js";
import type { Numbering } from "../fold/numbering.js";
import type { TreeReader } from "../git/tree.js";
import { escapeMarkdown, type IndexSpec } from "../log-index/render.js";
import { renderLogIndex } from "../log-index/tool-render.js";
import { exampleMachineKind as kind } from "../testing/example-machine-kind.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { verifyLog } from "../verify/verify.js";
import { parseCommitTemplate } from "./commit-message.js";
import {
  indexAfterHint,
  indexBeforeHint,
  indexRerunHint,
  type LogIndexRender,
  type LogIndexRunOptions,
  logIndexCheck,
  runLogIndex,
  type ToolWriteOptions,
} from "./tool-index.js";
import { openToolLog, type ToolLog } from "./tool-log.js";

const A = "aaaaaaaa";
const B = "bbbbbbbb";
const PATH = "log/index.md";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(files?: Record<string, string>): Promise<TempRepo> {
  const r = await createTempRepo(files === undefined ? {} : { files });
  repos.push(r);
  return r;
}

/** A `published` event file of `subject`; the numbering and the views read only its path. */
const published = (subject: string, day: number) =>
  `log/events/${subject}/202601${String(day).padStart(2, "0")}T000000Z-0000-published.yaml`;

interface View {
  readonly id: string;
  readonly display: string;
}

async function views(tree: TreeReader, numbering: Numbering): Promise<View[]> {
  const ids = new Set(
    (await tree.list("log/events")).map((e) => e.path.split("/")[2] ?? "").filter((x) => x),
  );
  return [...ids].map((id) => ({ id, display: `W-${numbering.byId.get(id) ?? 0}` }));
}

const spec = (_root: string, _views: readonly View[]): IndexSpec<View> => ({
  tool: "widget",
  title: "Widgets",
  groups: [{ heading: "All", filter: () => true }],
  columns: [{ heading: "Widget", cell: (v) => escapeMarkdown(v.display) }],
  order: (a, b) => (a.display < b.display ? -1 : a.display > b.display ? 1 : 0),
});

const render: LogIndexRender = (git, at) =>
  renderLogIndex(git, { kind, layout: kind.layoutAt("log"), mainRef: null, views, spec, ...at });

const words = { tool: "widget", noun: "widget", render };

const options = (o: Partial<LogIndexRunOptions<"widget-index/v1">> = {}) => ({
  ...words,
  plural: "widgets",
  format: "widget-index/v1" as const,
  index: "committed",
  autoCommit: false,
  commitSubject: parseCommitTemplate("docs(widget): {action} {title}", {
    vars: { action: 20 },
    where: "widget.toml: commit.subject",
  }),
  title: "the widget index",
  action: "regenerate",
  ...o,
});

const open = (r: TempRepo, o: { ref?: string; reader?: "index" } = {}) =>
  openToolLog({ cwd: r.root, tool: "widget", kind, gitOptions: { env: r.env }, ...o });

const index = async (
  r: TempRepo,
  o: ToolWriteOptions & { check?: boolean } = {},
  t: Partial<LogIndexRunOptions<"widget-index/v1">> = {},
  log?: ToolLog,
) => runLogIndex(log ?? (await open(r)), options(t), o);

const worktreeIndex = (r: TempRepo) => readFile(join(r.root, PATH), "utf8");
const out = async (r: TempRepo, args: string[]) =>
  new TextDecoder().decode((await r.git.run(args)).stdout);
const headIndex = (r: TempRepo) => out(r, ["show", `HEAD:${PATH}`]);
const stagedIndex = (r: TempRepo) => out(r, ["show", `:${PATH}`]);
const subject = async (r: TempRepo) => (await out(r, ["log", "-1", "--format=%s"])).trim();

describe("the recovery hints", () => {
  it("reproduce adr's texts", () => {
    expect(indexRerunHint("adr")).toBe(
      "You can also run adr index --commit again once git accepts the commit; it commits index.md while it differs from HEAD's.",
    );
    expect(indexBeforeHint("adr", "decisions", "docs/adr")).toBe(
      "Run adr index --no-commit first; it writes and stages docs/adr/index.md from the work tree. If other decisions in docs/adr have uncommitted changes, the work tree's index includes them; append their paths after -- in the command below, so the commit matches the index.",
    );
    expect(indexAfterHint("adr", "decisions", "docs/adr")).toBe(
      "Then run adr index --no-commit to restore other decisions' entries in docs/adr/index.md.",
    );
  });

  it("reproduce issues' texts", () => {
    expect(indexRerunHint("issues")).toBe(
      "You can also run issues index --commit again once git accepts the commit; it commits index.md while it differs from HEAD's.",
    );
    expect(indexBeforeHint("issues", "issues", "docs/issues")).toBe(
      "Run issues index --no-commit first; it writes and stages docs/issues/index.md from the work tree. If other issues in docs/issues have uncommitted changes, the work tree's index includes them; append their paths after -- in the command below, so the commit matches the index.",
    );
    expect(indexAfterHint("issues", "issues", "docs/issues")).toBe(
      "Then run issues index --no-commit to restore other issues' entries in docs/issues/index.md.",
    );
  });
});

describe("runLogIndex", () => {
  it('needs [log] index = "committed"', async () => {
    const r = await repo({ [published(A, 1)]: "x\n" });
    await expect(index(r, {}, { index: "none" })).rejects.toThrow(
      new UsageError('widget index needs [log] index = "committed" in widget.toml'),
    );
  });

  it("checks without writing, and refuses to commit with --check", async () => {
    const r = await repo({ [published(A, 1)]: "x\n" });
    const missing = await index(r, { check: true, notes: ["n"] });
    expect(missing.refreshed).toBe(false);
    expect(missing.doc).toMatchObject({
      format: "widget-index/v1",
      path: PATH,
      check: true,
      fresh: false,
      written: [],
      commit: null,
      notes: ["n"],
    });
    expect(missing.doc.findings.map((f) => [f.rule, f.message])).toEqual([
      ["index/missing", `${PATH} is missing; run widget index and commit it`],
    ]);
    await expect(index(r, { check: true, commit: true })).rejects.toThrow(
      new UsageError("--check writes nothing; drop --commit and --message"),
    );
    await expect(index(r, { check: true, message: "m" })).rejects.toThrow(UsageError);
    await index(r, { commit: false });
    expect((await index(r, { check: true })).doc).toMatchObject({ fresh: true, findings: [] });
  });

  it("checks a ref, and writes only the work tree", async () => {
    const r = await repo({ [published(A, 1)]: "x\n" });
    const log = await open(r, { ref: "HEAD" });
    const doc = (await index(r, { check: true }, {}, log)).doc;
    expect(doc.findings.map((f) => f.rule)).toEqual(["index/missing"]);
    await expect(index(r, {}, {}, log)).rejects.toThrow(
      new UsageError("widget index writes the work tree; use --ref only with --check"),
    );
    await expect(index(r, {}, {}, await open(r, { reader: "index" }))).rejects.toThrow(
      new UsageError("widget index writes the work tree; use --ref only with --check"),
    );
  });

  it("writes and stages the work tree's render without a commit", async () => {
    const r = await repo({ [published(A, 1)]: "x\n" });
    await r.write(published(B, 2), "x\n");
    const first = await index(r);
    expect(first).toEqual({
      doc: {
        format: "widget-index/v1",
        path: PATH,
        check: false,
        fresh: false,
        written: [PATH],
        commit: null,
        findings: [],
        notes: [],
      },
      refreshed: false,
    });
    expect(await worktreeIndex(r)).toContain("| W-2 |");
    expect(await stagedIndex(r)).toBe(await worktreeIndex(r));
    expect((await index(r)).doc).toMatchObject({ fresh: true, written: [] });
  });

  it("commits HEAD's render, then refreshes the work tree's copy", async () => {
    const r = await repo({ [published(A, 1)]: "x\n" });
    await r.write(published(B, 2), "x\n");
    const run = await index(r, {}, { autoCommit: true });
    const sha = await r.git.resolveCommit("HEAD");
    expect(run).toEqual({
      doc: {
        format: "widget-index/v1",
        path: PATH,
        check: false,
        fresh: false,
        written: [PATH],
        commit: sha,
        findings: [],
        notes: [],
      },
      refreshed: true,
    });
    expect(await subject(r)).toBe("docs(widget): regenerate the widget index");
    expect(await headIndex(r)).toContain("| W-1 |");
    expect(await headIndex(r)).not.toContain("| W-2 |");
    expect(await worktreeIndex(r)).toContain("| W-2 |");

    const again = await index(r, { commit: true, message: "unused" });
    expect(again).toMatchObject({ doc: { fresh: true, commit: null, written: [] } });
    expect(again.refreshed).toBe(false);
    expect(await r.git.resolveCommit("HEAD")).toBe(sha);
  });

  it("commits with the given message", async () => {
    const r = await repo({ [published(A, 1)]: "x\n" });
    const run = await index(r, { commit: true, message: "chore: index" });
    expect(run.refreshed).toBe(false);
    expect(await subject(r)).toBe("chore: index");
  });

  it("needs numbers to write", async () => {
    const r = await repo({ [published(A, 1)]: "x\n" });
    const shallow = new UsageError(
      "numbers need history in this shallow clone; run git fetch --unshallow",
    );
    const none: LogIndexRender = async () => null;
    await expect(index(r, {}, { render: none })).rejects.toThrow(shallow);
    await expect(index(r, { commit: true }, { render: none })).rejects.toThrow(shallow);
  });

  it("notes a failed refresh after the commit", async () => {
    const r = await repo({ [published(A, 1)]: "x\n" });
    const failing: LogIndexRender = async (git, at) => {
      if (at.tree.label === "worktree") throw new Error("boom\nmore");
      return render(git, at);
    };
    const run = await index(r, { commit: true }, { render: failing });
    expect(run.refreshed).toBe(false);
    expect(run.doc.commit).toBe(await r.git.resolveCommit("HEAD"));
    expect(run.doc.notes).toEqual([`${PATH} may be stale: boom; run widget index`]);
  });

  it("needs a git identity to commit", async () => {
    const r = await repo({ [published(A, 1)]: "x\n" });
    const env = { ...r.env, GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined };
    const log = await openToolLog({ cwd: r.root, tool: "widget", kind, gitOptions: { env } });
    expect(await log.git.identity()).toBeNull();
    await expect(index(r, { commit: true }, {}, log)).rejects.toThrow(
      new ConfigError("--commit needs a git identity; set git user.name and user.email"),
    );
  });
});

describe("logIndexCheck", () => {
  it("names the unstaged files when the staged index is the work tree's render", async () => {
    const r = await repo({ [published(A, 1)]: "x\n" });
    await index(r, { commit: true });
    await r.write(published(B, 2), "x\n");
    await index(r);
    const log = await open(r, { reader: "index" });
    const findings = await verifyLog({
      git: log.git,
      kind,
      layout: log.layout,
      mode: { type: "staged" },
      checks: [logIndexCheck(log, words)],
    });
    expect(findings.map((f) => [f.rule, f.message])).toEqual([
      [
        "index/stale",
        `${PATH} lists widget files that aren't staged (${published(B, 2)}); git add them and commit again, or move them out of the work tree and run widget index`,
      ],
    ]);
  });

  it("keeps the finding when the staged index isn't the work tree's render", async () => {
    const r = await repo({ [published(A, 1)]: "x\n" });
    await index(r, { commit: true });
    await r.write(PATH, "stale\n");
    await r.stage(PATH);
    await r.write(published(B, 2), "x\n");
    const log = await open(r, { reader: "index" });
    const findings = await verifyLog({
      git: log.git,
      kind,
      layout: log.layout,
      mode: { type: "staged" },
      checks: [logIndexCheck(log, words)],
    });
    expect(findings.map((f) => [f.rule, f.message])).toEqual([
      ["index/stale", `${PATH} is not what the tool generates; run widget index and commit it`],
    ]);
  });
});
