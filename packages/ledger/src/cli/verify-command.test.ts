import { afterEach, describe, expect, it } from "vitest";
import type { EventEnvelope } from "../envelope/types.js";
import { serializeEvent } from "../envelope/yaml.js";
import { SourceFetchError } from "../errors.js";
import type { Severity } from "../findings/finding.js";
import { formatJson } from "../findings/format.js";
import { eventPath } from "../identity/layout.js";
import type { SourceStatus } from "../sources/read.js";
import { exampleMachineKind as kind } from "../testing/example-machine-kind.js";
import { TEST_HUMAN } from "../testing/history.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { foldChecks } from "../verify/fold-checks.js";
import type { VerifyMode } from "../verify/verify.js";
import { runCli } from "./run.js";
import { resolveVerifyBase, verifyCommand } from "./verify-command.js";

const layout = kind.layoutAt("log");
const S = "a7c2m9xd";
const event = (o: Partial<EventEnvelope> = {}): EventEnvelope => ({
  envelope: "ledger/v1",
  kind: "widget",
  schema: "widget/v1",
  id: "01JAB3K9Z6Q8M2X7FQ0V4TQ8A1",
  subject: S,
  type: "created",
  at: "2026-03-14T12:02:11Z",
  actor: TEST_HUMAN,
  data: { title: "A widget" },
  ...o,
});
const file = (e: EventEnvelope) => ({ [eventPath(layout, e)]: serializeEvent(e) });
const LOG = { ...file(event()), [`log/items/${S}-widget.md`]: "# Widget\n" };
// `revived` is only allowed while retired: transition/illegal.
const ILLEGAL = event({
  id: "01JAB3K9Z6Q8M2X7FQ0V4TQ8A2",
  type: "revived",
  at: "2026-03-15T08:00:00Z",
  data: {},
});
const ILLEGAL_PATH = eventPath(layout, ILLEGAL);

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(): Promise<TempRepo> {
  const r = await createTempRepo({ files: LOG });
  repos.push(r);
  return r;
}

async function call(
  r: TempRepo | null,
  argv: readonly string[],
  o: {
    failOn?: Severity;
    notes?: readonly string[];
    widenOn?: readonly string[];
    sources?: readonly SourceStatus[];
    fetchError?: boolean;
  } = {},
) {
  let stdout = "";
  let stderr = "";
  const modes: VerifyMode[] = [];
  const fetches: boolean[] = [];
  const verify = verifyCommand({
    async open({ mode, fetchSources }) {
      modes.push(mode);
      fetches.push(fetchSources);
      if (r === null) throw new Error("open called");
      if (o.fetchError === true && fetchSources) {
        throw new SourceFetchError("platform", "cannot fetch source platform (main): fatal: nope");
      }
      return {
        git: r.git,
        kind,
        layout,
        checks: foldChecks(kind),
        failOn: o.failOn ?? "error",
        ...(o.notes === undefined ? {} : { notes: o.notes }),
        ...(o.widenOn === undefined ? {} : { widenOn: o.widenOn }),
        ...(o.sources === undefined ? {} : { sources: o.sources }),
      };
    },
  });
  const code = await runCli(
    { name: "w", version: "0.0.0", summary: "widgets", commands: [verify] },
    {
      argv,
      cwd: r?.root ?? "/",
      env: {},
      stdout: {
        write: (s) => {
          stdout += s;
        },
      },
      stderr: {
        write: (s) => {
          stderr += s;
        },
      },
      interactive: false,
      stdoutIsTTY: false,
    },
  );
  return { code, stdout, stderr, modes, fetches };
}

describe("verifyCommand flags", () => {
  it.each([
    [["verify", "--staged", "--base", "main"], "--staged can't be combined with --base or --ref"],
    [["verify", "--staged", "--ref", "HEAD"], "--staged can't be combined with --base or --ref"],
    [["--json", "verify", "--format", "text"], "--json can't be combined with --format text"],
    [["verify", "--json", "--format=github"], "--json can't be combined with --format github"],
    [["verify", "--format", "xml"], "--format must be text, json or github"],
    [["verify", "--base", " "], "--base must not be empty"],
    [["verify", "extra"], 'unexpected argument "extra"'],
  ])("%j is a usage error", async (argv, message) => {
    const r = await call(null, argv);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(
      `w: error: ${message}${message.startsWith("unexpected") ? "; usage: w verify [--staged | --base <ref>] [--fetch-sources] [--format text|json|github]" : ""}\n`,
    );
    expect(r.modes).toEqual([]);
  });

  it("accepts --json with --format json", async () => {
    const r = await repo();
    expect((await call(r, ["verify", "--json", "--format", "json"])).code).toBe(0);
  });

  it.each([
    [["verify"], { type: "full" }],
    [["verify", "--ref", "HEAD"], { type: "full", head: "HEAD" }],
    [["verify", "--base", "main"], { type: "range", base: "main" }],
    [["--ref", "HEAD", "verify", "--base", "main"], { type: "range", base: "main", head: "HEAD" }],
    [["verify", "--staged"], { type: "staged" }],
  ])("%j opens the log in mode %j", async (argv, mode) => {
    const r = await repo();
    const out = await call(r, argv);
    expect(out.modes).toEqual([mode]);
    expect(out).toMatchObject({ code: 0, stdout: "No findings.\n", stderr: "" });
  });
});

describe("verifyCommand on a repository", () => {
  it("staged mode reports a staged illegal transition", async () => {
    const r = await repo();
    await r.writeFiles(file(ILLEGAL));
    expect((await call(r, ["verify", "--staged"])).code).toBe(0);
    await r.stage(ILLEGAL_PATH);
    const out = await call(r, ["verify", "--staged"]);
    expect(out.code).toBe(1);
    expect(out.stdout).toBe(
      `${ILLEGAL_PATH}: error: revived is not allowed while draft [transition/illegal] (${S})\n\n1 error, 0 warnings\n`,
    );
  });

  it("range mode reports a branch's illegal transition, full mode the work tree", async () => {
    const r = await repo();
    await r.checkout("topic", { create: true });
    await r.writeFiles(file(ILLEGAL));
    expect((await call(r, ["verify"])).code).toBe(1);
    expect((await call(r, ["verify", "--ref", "HEAD"])).code).toBe(0);
    await r.stage(ILLEGAL_PATH);
    await r.commit("illegal");
    await r.checkout("main");
    expect((await call(r, ["verify"])).code).toBe(0);
    const range = await call(r, ["verify", "--base", "main", "--ref", "topic"]);
    expect(range.code).toBe(1);
    expect(range.stdout).toContain("[transition/illegal]");
    expect((await call(r, ["verify", "--base", "main"])).code).toBe(0);
    const github = await call(r, ["verify", "--ref", "topic", "--format", "github"]);
    expect(github.code).toBe(1);
    expect(github.stdout).toMatch(/^::error file=log\/events\/a7c2m9xd\/.*\n$/);
  });

  it("prints --json byte-identical to --format json and the ledger report", async () => {
    const r = await repo();
    await r.writeFiles(file(ILLEGAL));
    const a = await call(r, ["verify", "--json"]);
    const b = await call(r, ["verify", "--format", "json"]);
    expect(a.code).toBe(1);
    expect(b.code).toBe(1);
    expect(a.stdout).toBe(b.stdout);
    const report = JSON.parse(a.stdout) as { format: string; findings: unknown[] };
    expect(report.format).toBe("ledger-findings/v1");
    expect(report.findings).toHaveLength(1);
    expect(a.stdout).toBe(
      formatJson(report.findings as Parameters<typeof formatJson>[0], { failOn: "error" }),
    );
  });

  it("applies the tool's failOn", async () => {
    const r = await repo();
    await r.writeFiles(file(ILLEGAL));
    const out = await call(r, ["--json", "verify"], { failOn: "warning" });
    expect(out.code).toBe(1);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false });
  });

  it("widens --staged when a staged input changes, and says so", async () => {
    const r = await repo();
    const widenOn = ["w.toml", "templates/"];
    await r.writeFiles({
      "w.toml": "x = 1\n",
      "templates/a.md": "# A\n",
      "templates/b.md": "# B\n",
    });
    expect((await call(r, ["verify", "--staged"], { widenOn })).stderr).toBe("");
    await r.stage("w.toml");
    expect((await call(r, ["verify", "--staged"], { widenOn })).stderr).toBe(
      "w: warning: --staged checks every widget: the staged changes touch w.toml\n",
    );
    await r.stage("templates/a.md", "templates/b.md");
    const out = await call(r, ["verify", "--staged"], { widenOn });
    expect(out.code).toBe(0);
    expect(out.stderr).toBe(
      "w: warning: --staged checks every widget: the staged changes touch templates/a.md and 2 more\n",
    );
    expect((await call(r, ["verify"], { widenOn })).stderr).toBe("");
  });

  it("passes --fetch-sources to open and reports the sources it read", async () => {
    const r = await repo();
    const sources: SourceStatus[] = [
      { name: "platform", kind: "widget", ref: "v1", commit: "a".repeat(40), fetched: true },
      { name: "cached", kind: "widget", ref: "main", commit: "b".repeat(40), fetched: false },
      { name: "missing", kind: "widget", ref: "main", commit: null, fetched: false },
    ];
    const plain = await call(r, ["verify"], { sources });
    expect(plain.fetches).toEqual([false]);
    expect(plain.stderr).toBe(
      `w: warning: source platform (v1) at ${"a".repeat(12)}, fetched now\n` +
        `w: warning: source cached (main) at ${"b".repeat(12)}, from the cache\n`,
    );
    const json = await call(r, ["verify", "--fetch-sources", "--json"], { sources });
    expect(json.fetches).toEqual([true]);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout).sources).toEqual(sources);
    const format = await call(r, ["verify", "--fetch-sources", "--format", "json"], { sources });
    expect(format.stdout).toBe(json.stdout);
    expect((await call(r, ["verify", "--staged", "--fetch-sources"])).fetches).toEqual([true]);
  });

  it("exits 2 with ark-error/v1 when a source can't be fetched", async () => {
    const r = await repo();
    const text = await call(r, ["verify", "--fetch-sources"], { fetchError: true });
    expect(text.code).toBe(2);
    expect(text.stderr).toBe("w: error: cannot fetch source platform (main): fatal: nope\n");
    const json = await call(r, ["--json", "verify", "--fetch-sources"], { fetchError: true });
    expect(json.code).toBe(2);
    expect(JSON.parse(json.stdout)).toMatchObject({
      format: "ark-error/v1",
      error: { code: "source-fetch" },
    });
    expect((await call(r, ["verify"], { fetchError: true })).code).toBe(0);
  });

  it("prints the tool's notes on stderr and keeps them out of the report", async () => {
    const r = await repo();
    const out = await call(r, ["verify", "--json"], { notes: ["ignoring w.toml"] });
    expect(out.code).toBe(0);
    expect(out.stderr).toBe("w: warning: ignoring w.toml\n");
    expect(Object.keys(JSON.parse(out.stdout))).toEqual(["format", "ok", "summary", "findings"]);
  });

  it("verifies against origin's default branch without an upstream, and says so", async () => {
    const r = await repo();
    await r.git.run(["remote", "add", "origin", "https://example.invalid/w.git"]);
    await r.git.run(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await r.checkout("topic", { create: true });
    await r.writeFiles(file(ILLEGAL));
    await r.stage(ILLEGAL_PATH);
    await r.commit("illegal");
    const out = await call(r, ["verify", "--base", "@{upstream}", "--ref", "HEAD"], {
      notes: ["ignoring w.toml"],
    });
    expect(out.code).toBe(1);
    expect(out.stdout).toContain("[transition/illegal]");
    expect(out.stderr).toBe(
      "w: warning: ignoring w.toml\nw: warning: no upstream for this branch; verifying against origin/main\n",
    );
  });

  it("verifies the whole log without an upstream or a remote", async () => {
    const r = await repo();
    await r.writeFiles(file(ILLEGAL));
    const out = await call(r, ["verify", "--base", "@{u}"]);
    expect(out.code).toBe(1);
    expect(out.stderr).toBe("w: warning: no upstream and no remote; verifying the whole log\n");
  });

  it("exits 2 for a missing ref or no merge base", async () => {
    const r = await repo();
    const missing = await call(r, ["verify", "--ref", "nope"]);
    expect(missing).toMatchObject({ code: 2, stderr: "w: error: ref not found: nope\n" });
    // Only an upstream spec falls back; another unresolvable base is still an error.
    const base = await call(r, ["verify", "--base", "nope"]);
    expect(base).toMatchObject({ code: 2, stderr: "w: error: ref not found: nope\n" });
    const orphan = await r.git.run([
      "commit-tree",
      "-m",
      "orphan",
      `${await r.git.resolveCommit("HEAD")}^{tree}`,
    ]);
    const sha = Buffer.from(orphan.stdout).toString().trim();
    const unrelated = await call(r, ["--json", "verify", "--base", sha]);
    expect(unrelated.code).toBe(2);
    expect(JSON.parse(unrelated.stdout)).toMatchObject({ error: { code: "verify-usage" } });
  });
});

describe("resolveVerifyBase", () => {
  const upstream: VerifyMode = { type: "range", base: "@{upstream}", head: "HEAD" };
  const git = (r: TempRepo, ...args: string[]) => r.git.run(args);

  it("keeps a resolving upstream", async () => {
    const r = await repo();
    await r.checkout("topic", { create: true });
    await git(r, "config", "branch.topic.remote", ".");
    await git(r, "config", "branch.topic.merge", "refs/heads/main");
    expect(await resolveVerifyBase(r.git, upstream)).toEqual({ mode: upstream, note: null });
  });

  it.each([
    [{ type: "full" }],
    [{ type: "staged" }],
    [{ type: "range", base: "nope" }],
    [{ type: "range", base: "main" }],
  ] as const)("leaves %j alone", async (mode) => {
    const r = await repo();
    expect(await resolveVerifyBase(r.git, mode)).toEqual({ mode, note: null });
  });

  it("prefers origin/HEAD's target", async () => {
    const r = await repo();
    await git(r, "remote", "add", "origin", "https://example.invalid/w.git");
    await git(r, "update-ref", "refs/remotes/origin/trunk", "HEAD");
    await git(r, "update-ref", "refs/remotes/origin/main", "HEAD");
    await git(r, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    expect(await resolveVerifyBase(r.git, upstream)).toEqual({
      mode: { type: "range", base: "refs/remotes/origin/trunk", head: "HEAD" },
      note: "no upstream for this branch; verifying against origin/trunk",
    });
  });

  it.each(["main", "master"])("falls back to origin/%s", async (branch) => {
    const r = await repo();
    await git(r, "remote", "add", "origin", "https://example.invalid/w.git");
    await git(r, "update-ref", `refs/remotes/origin/${branch}`, "HEAD");
    // An origin/HEAD whose target isn't fetched is skipped.
    await git(r, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/gone");
    expect(await resolveVerifyBase(r.git, { type: "range", base: "main@{u}" })).toEqual({
      mode: { type: "range", base: `refs/remotes/origin/${branch}` },
      note: `no upstream for this branch; verifying against origin/${branch}`,
    });
  });

  it("verifies the whole log when origin has no default branch here", async () => {
    const r = await repo();
    await git(r, "remote", "add", "origin", "https://example.invalid/w.git");
    expect(await resolveVerifyBase(r.git, upstream)).toEqual({
      mode: { type: "full", head: "HEAD" },
      note: "no upstream, and origin has no default branch here; verifying the whole log",
    });
  });

  it("verifies the whole log without a remote", async () => {
    const r = await repo();
    expect(await resolveVerifyBase(r.git, { type: "range", base: "@{U}" })).toEqual({
      mode: { type: "full" },
      note: "no upstream and no remote; verifying the whole log",
    });
  });
});
