import { afterEach, describe, expect, it } from "vitest";
import { compileKind } from "../envelope/kind.js";
import type { EventEnvelope } from "../envelope/types.js";
import { serializeEvent } from "../envelope/yaml.js";
import { InvalidArgumentError, RefNotFoundError, VerifyUsageError } from "../errors.js";
import type { Finding } from "../findings/finding.js";
import { MemoryTree } from "../git/tree.js";
import { bodySha256 } from "../identity/hash.js";
import { eventPath } from "../identity/layout.js";
import { exampleKind, exampleLayout as layout } from "../testing/example-kind.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import type { CheckContext, RepoContext } from "./checks.js";
import { type VerifyMode, verifyLog, verifySnapshots } from "./verify.js";

const S = "a7c2m9xd";
const BODY = "# Widget\n\nBody text.\n";
const BODY_PATH = `log/items/${S}-widget.md`;

const event = (o: Partial<EventEnvelope> = {}): EventEnvelope => ({
  envelope: "ledger/v1",
  kind: "widget",
  schema: "widget/v1",
  id: "01JAB3K9Z6Q8M2X7FQ0V4TQ8A1",
  subject: S,
  type: "created",
  at: "2026-03-14T12:02:11Z",
  actor: { kind: "human", name: "Ada" },
  data: { title: "A widget" },
  ...o,
});
const created = event();
const frozen = event({
  id: "01JAB3K9Z6Q8M2X7FQ0V4TFRZ1",
  type: "frozen",
  at: "2026-03-15T08:00:00Z",
  data: { body_sha256: bodySha256(new TextEncoder().encode(BODY)) },
});
const noted = event({ id: "01JAB3K9Z6Q8M2X7FQ0V4TN0TE", type: "noted", data: {} });
const file = (e: EventEnvelope) => ({ [eventPath(layout, e)]: serializeEvent(e) });
const CREATED = eventPath(layout, created);
const log = { ...file(created), ...file(frozen), [BODY_PATH]: BODY };

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(files?: Record<string, string>): Promise<TempRepo> {
  const r = await createTempRepo(files === undefined ? {} : { files });
  repos.push(r);
  return r;
}

const verify = (r: TempRepo, mode: VerifyMode) =>
  verifyLog({ git: r.git, kind: exampleKind, layout, mode });
const brief = (fs: readonly Finding[]) => fs.map((f) => [f.rule, f.file]);

describe("verifyLog", () => {
  it("range mode reports an event modified on a branch", async () => {
    const r = await repo(log);
    await r.checkout("topic", { create: true });
    await r.write(CREATED, serializeEvent(event({ data: { title: "Changed" } })));
    await r.commit("tamper", { all: true });
    const findings = await verify(r, { type: "range", base: "main", head: "topic" });
    expect(findings).toEqual([
      expect.objectContaining({ rule: "append-only/modified", file: CREATED, kind: "widget" }),
    ]);
    // Without a head, the work tree is checked against the merge base.
    expect(brief(await verify(r, { type: "range", base: "main" }))).toEqual([
      ["append-only/modified", CREATED],
    ]);
    expect(await verify(r, { type: "range", base: "topic", head: "main" })).toEqual([]);
  });

  it("staged mode rejects a staged frozen-body edit", async () => {
    const r = await repo(log);
    await r.write(BODY_PATH, `${BODY}more\n`);
    await r.stage(BODY_PATH);
    expect(brief(await verify(r, { type: "staged" }))).toEqual([
      ["body/hash-mismatch", eventPath(layout, frozen)],
      ["body/frozen-modified", BODY_PATH],
    ]);
  });

  it("staged mode passes a new valid event and ignores unstaged changes", async () => {
    const r = await repo(log);
    await r.writeFiles(file(noted));
    await r.stage(eventPath(layout, noted));
    await r.write(BODY_PATH, "unstaged edit\n");
    expect(await verify(r, { type: "staged" })).toEqual([]);
  });

  it("staged mode reports staged structural problems", async () => {
    const r = await repo(log);
    const bad = {
      "log/events/README.md": "x",
      "log/events/NOTANID/x.yaml": "x",
      "log/items/foo.md": "x",
    };
    await r.writeFiles(bad);
    await r.stage(...Object.keys(bad));
    expect(brief(await verify(r, { type: "staged" }))).toEqual([
      ["identity/invalid-subject-dir", "log/events/NOTANID/x.yaml"],
      ["identity/invalid-subject-dir", "log/events/README.md"],
      ["identity/body-file-name", "log/items/foo.md"],
    ]);
  });

  it("leaves pre-existing structural problems to full mode", async () => {
    const r = await repo({ ...log, "log/events/README.md": "x" });
    await r.writeFiles(file(noted));
    await r.stage(eventPath(layout, noted));
    expect(await verify(r, { type: "staged" })).toEqual([]);
    expect(brief(await verify(r, { type: "full" }))).toEqual([
      ["identity/invalid-subject-dir", "log/events/README.md"],
    ]);
  });

  it("range mode is clean on a CRLF checkout of LF files", async () => {
    const r = await repo(log);
    await r.git.run(["config", "core.autocrlf", "true"]);
    await r.remove("log");
    await r.git.run(["checkout", "--", "log"]);
    const eol = await r.git.run(["ls-files", "--eol", "--", BODY_PATH]);
    expect(Buffer.from(eol.stdout).toString()).toContain("w/crlf");
    expect(await verify(r, { type: "range", base: "HEAD" })).toEqual([]);
  });

  it("full mode checks a past ref", async () => {
    const r = await repo(log);
    const v1 = (await r.git.resolveCommit("HEAD")) ?? "";
    await r.write(`log/events/${S}/broken.yaml`, "a: [");
    await r.stage("log");
    await r.commit("broken");
    expect(await verify(r, { type: "full", head: v1 })).toEqual([]);
    expect(brief(await verify(r, { type: "full", head: "HEAD" }))).toEqual([
      ["identity/file-name", `log/events/${S}/broken.yaml`],
      ["event/unparseable", `log/events/${S}/broken.yaml`],
    ]);
  });

  it("throws usage errors for a missing ref or merge base", async () => {
    const r = await repo(log);
    await expect(verify(r, { type: "range", base: "nope" })).rejects.toBeInstanceOf(
      RefNotFoundError,
    );
    await r.git.run(["checkout", "-q", "--orphan", "other"]);
    await r.commit("unrelated", { allowEmpty: true });
    const unrelated = verify(r, { type: "range", base: "main", head: "other" });
    await expect(unrelated).rejects.toBeInstanceOf(VerifyUsageError);
    await expect(unrelated).rejects.toThrow("no common ancestor between main and other");
  });

  it("staged mode on an unborn HEAD checks the staged files alone", async () => {
    const r = await repo();
    await r.writeFiles(log);
    await r.stage("log");
    expect(await verify(r, { type: "staged" })).toEqual([]);
    await r.write(`log/events/${S}/.gitkeep`, "");
    await r.stage(`log/events/${S}/.gitkeep`);
    expect(await verify(r, { type: "staged" })).toEqual([
      expect.objectContaining({ rule: "identity/stray-file", severity: "warning" }),
    ]);
  });

  it("gives the checks the repository context of each mode", async () => {
    const r = await repo(log);
    const main = (await r.git.resolveCommit("HEAD")) ?? "";
    await r.checkout("topic", { create: true });
    const topic = await r.commit("empty", { allowEmpty: true });
    const seen: (RepoContext | undefined)[] = [];
    const probe = {
      id: "probe",
      run: (ctx: CheckContext) => {
        seen.push(ctx.repo);
        return [];
      },
    };
    const run = (mode: VerifyMode) =>
      verifyLog({ git: r.git, kind: exampleKind, layout, mode, checks: [probe] });
    await run({ type: "staged" });
    await run({ type: "range", base: "main" });
    await run({ type: "range", base: "main", head: "topic" });
    await run({ type: "full" });
    await run({ type: "full", head: "main" });
    expect(seen).toEqual([
      { git: r.git, mode: "staged", head: "index", base: topic },
      { git: r.git, mode: "range", head: "worktree", base: main },
      { git: r.git, mode: "range", head: { commit: topic }, base: main },
      { git: r.git, mode: "full", head: "worktree", base: null },
      { git: r.git, mode: "full", head: { commit: main }, base: null },
    ]);

    const unborn = await repo();
    seen.length = 0;
    await verifyLog({
      git: unborn.git,
      kind: exampleKind,
      layout,
      mode: { type: "staged" },
      checks: [probe],
    });
    expect(seen).toEqual([{ git: unborn.git, mode: "staged", head: "index", base: null }]);

    // verifySnapshots leaves it unset unless given.
    seen.length = 0;
    await verifySnapshots({
      kind: compileKind(exampleKind),
      layout,
      base: null,
      head: new MemoryTree(log),
      scope: "all",
      checks: [probe],
    });
    expect(seen).toEqual([undefined]);
  });

  it("rejects a layout that doesn't match the kind", async () => {
    const r = await repo(log);
    await expect(
      verifyLog({
        git: r.git,
        kind: exampleKind,
        layout: { ...layout, bodies: null },
        mode: { type: "full" },
      }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});
