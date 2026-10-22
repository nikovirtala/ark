import { afterEach, describe, expect, it } from "vitest";
import { compileKind } from "../envelope/kind.js";
import type { EventEnvelope } from "../envelope/types.js";
import { serializeEvent } from "../envelope/yaml.js";
import type { Finding } from "../findings/finding.js";
import { indexReader, MemoryTree, type TreeEntry, type TreeReader } from "../git/tree.js";
import { bodySha256 } from "../identity/hash.js";
import { eventPath } from "../identity/layout.js";
import { exampleKind, exampleLayout as layout } from "../testing/example-kind.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { type LogSnapshot, loadLog } from "./snapshot.js";

const kind = compileKind(exampleKind);
const S = "a7c2m9xd";
const T = "k3f9q8a1";
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
const frozen = event({
  id: "01JAB3K9Z6Q8M2X7FQ0V4TZZZZ",
  type: "frozen",
  at: "2026-03-15T08:00:00Z",
  data: { body_sha256: bodySha256(new TextEncoder().encode(BODY)) },
});
const at = (e: EventEnvelope) => ({ [eventPath(layout, e)]: serializeEvent(e) });
const valid = { ...at(event()), ...at(frozen), [BODY_PATH]: BODY };

const load = (files: Record<string, string>, subjects?: ReadonlySet<string>) =>
  loadLog(new MemoryTree(files), { kind, layout, ...(subjects === undefined ? {} : { subjects }) });

function findingsOf(snap: LogSnapshot): Finding[] {
  return [
    ...snap.structural,
    ...[...snap.subjects.values()].flatMap((s) => [
      ...s.findings,
      ...s.events.flatMap((e) => e.findings),
    ]),
  ];
}
const brief = (fs: readonly Finding[]) => fs.map((f) => [f.rule, f.file, f.subject]);

/** A tree with extra entries of other types on top of `files`. */
function withEntries(
  files: Record<string, string>,
  extra: readonly TreeEntry[],
  label = "memory",
): TreeReader {
  const mem = new MemoryTree(files);
  return {
    label,
    commit: null,
    list: async (prefix) =>
      [...(await mem.list(prefix)), ...extra.filter((e) => e.path.startsWith(`${prefix}/`))].sort(
        (a, b) => (a.path < b.path ? -1 : 1),
      ),
    read: (p) => mem.read(p),
    readMany: (ps) => mem.readMany(ps),
  };
}

describe("loadLog", () => {
  it("loads a valid log without findings", async () => {
    const snap = await load(valid);
    expect(findingsOf(snap)).toEqual([]);
    expect([...snap.subjects.keys()]).toEqual([S]);
    const s = snap.subjects.get(S);
    expect(s?.events.map((e) => e.event?.type)).toEqual(["created", "frozen"]);
    expect(s?.events[0]).toMatchObject({
      path: `log/events/${S}/20260314T120211Z-q8a1-created.yaml`,
      name: { stamp: "20260314T120211Z", rand: "q8a1", type: "created" },
      versionKnown: true,
      findings: [],
    });
    expect(s?.bodyPaths).toEqual([BODY_PATH]);
    expect(s?.body?.path).toBe(BODY_PATH);
    expect(new TextDecoder().decode(s?.body?.bytes)).toBe(BODY);
    expect(s?.body?.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(s?.readable).toBe(true);
    expect(snap.kind).toBe(kind);
  });

  it("reports files outside events/<subject-id>/ as identity/invalid-subject-dir", async () => {
    const snap = await load({
      ...valid,
      "log/events/README.md": "x",
      "log/events/NOTANID/x.yaml": "x",
      [`log/events/${S}/sub/x.yaml`]: "x",
    });
    expect(brief(snap.structural)).toEqual([
      ["identity/invalid-subject-dir", "log/events/NOTANID/x.yaml", null],
      ["identity/invalid-subject-dir", "log/events/README.md", null],
      ["identity/invalid-subject-dir", `log/events/${S}/sub/x.yaml`, null],
    ]);
    expect(findingsOf(snap)).toHaveLength(3);
  });

  it("reports a malformed event file name and still validates the file", async () => {
    const content = serializeEvent(event());
    const snap = await load({
      [`log/events/${S}/created.yaml`]: content,
      [`log/events/${S}/20260314T120211Z-q8a1-created.yml`]: content,
      [`log/events/${S}/broken.yaml`]: "a: [",
    });
    expect(brief(findingsOf(snap))).toEqual([
      ["identity/file-name", `log/events/${S}/20260314T120211Z-q8a1-created.yml`, S],
      ["identity/file-name", `log/events/${S}/broken.yaml`, S],
      ["event/unparseable", `log/events/${S}/broken.yaml`, S],
      ["identity/file-name", `log/events/${S}/created.yaml`, S],
    ]);
    expect(snap.subjects.get(S)?.events.map((e) => e.event !== null)).toEqual([true, false, true]);
  });

  it("warns about stray files in an event directory", async () => {
    const snap = await load({ ...valid, [`log/events/${S}/.gitkeep`]: "" });
    expect(snap.subjects.get(S)?.findings).toEqual([
      {
        severity: "warning",
        rule: "identity/stray-file",
        message: "unexpected file in an event directory",
        file: `log/events/${S}/.gitkeep`,
        line: null,
        subject: S,
        kind: null,
      },
    ]);
  });

  it("reports symlinks and other entries as identity/not-a-regular-file", async () => {
    const tree = withEntries(valid, [
      { path: `log/events/${S}/link.yaml`, oid: null, type: "symlink" },
      { path: `log/items/${T}.md`, oid: null, type: "other" },
    ]);
    const snap = await loadLog(tree, { kind, layout });
    expect(brief(findingsOf(snap))).toEqual([
      ["identity/not-a-regular-file", `log/items/${T}.md`, null],
      ["identity/not-a-regular-file", `log/events/${S}/link.yaml`, S],
    ]);
  });

  describe("with a conflicted index", () => {
    let r: TempRepo | undefined;
    afterEach(async () => r?.dispose());

    it("reports unmerged paths as git/unmerged", async () => {
      r = await createTempRepo({ files: valid });
      const path = `log/events/${S}/20260314T120211Z-q8a1-created.yaml`;
      await r.checkout("topic", { create: true });
      await r.write(path, serializeEvent(event({ data: { title: "left" } })));
      await r.commit("left", { all: true });
      await r.checkout("main");
      await r.write(path, serializeEvent(event({ data: { title: "right" } })));
      await r.commit("right", { all: true });
      await r.git.run(["merge", "-q", "topic"], { okCodes: [0, 1] });

      const snap = await loadLog(await indexReader(r.git), { kind, layout });
      expect(brief(findingsOf(snap))).toEqual([["git/unmerged", path, S]]);
      expect(snap.subjects.get(S)?.events.map((e) => e.event?.type)).toEqual(["frozen"]);
    });
  });

  it("reports an event in another subject's directory as identity/subject-mismatch", async () => {
    const e = event({ subject: T });
    const snap = await load({ [eventPath(layout, event())]: serializeEvent(e) });
    expect(brief(findingsOf(snap))).toEqual([
      ["identity/subject-mismatch", eventPath(layout, event()), S],
    ]);
  });

  it("reports a name that doesn't match the envelope as identity/file-name-mismatch", async () => {
    const path = `log/events/${S}/20260314T120211Z-zzzz-created.yaml`;
    const snap = await load({ [path]: serializeEvent(event()) });
    expect(findingsOf(snap)).toEqual([
      expect.objectContaining({
        rule: "identity/file-name-mismatch",
        message:
          'file name does not match the event; expected "20260314T120211Z-q8a1-created.yaml"',
        file: path,
        subject: S,
      }),
    ]);
  });

  it("reports bad body file names as identity/body-file-name", async () => {
    const snap = await load({
      ...valid,
      "log/items/foo.md": "x",
      [`log/items/${S}_draft.md`]: "x",
      [`log/items/sub/${T}.md`]: "x",
    });
    expect(brief(snap.structural)).toEqual([
      ["identity/body-file-name", `log/items/${S}_draft.md`, S],
      ["identity/body-file-name", "log/items/foo.md", null],
      ["identity/body-file-name", `log/items/sub/${T}.md`, null],
    ]);
  });

  it("reads only the subjects in the filter but classifies everything", async () => {
    const other = event({ subject: T, id: "01JAB3K9Z6Q8M2X7FQ0V4TAAAA" });
    const files = { ...valid, ...at(other), "log/events/README.md": "x" };
    const mem = new MemoryTree(files);
    const read: string[] = [];
    const tree: TreeReader = {
      label: mem.label,
      commit: null,
      list: (p) => mem.list(p),
      read: (p) => {
        read.push(p);
        return mem.read(p);
      },
      readMany: (ps) => {
        read.push(...ps);
        return mem.readMany(ps);
      },
    };
    const snap = await loadLog(tree, { kind, layout, subjects: new Set([T]) });
    expect([...snap.subjects.keys()]).toEqual([T]);
    expect(read).toEqual([eventPath(layout, other)]);
    expect(brief(snap.structural)).toEqual([
      ["identity/invalid-subject-dir", "log/events/README.md", null],
    ]);
  });

  it("reports only envelope/schema for an event missing its subject", async () => {
    const { subject: _, ...doc } = event();
    const snap = await load({ [eventPath(layout, event())]: serializeEvent(doc) });
    expect(brief(findingsOf(snap))).toEqual([["envelope/schema", eventPath(layout, event()), S]]);
  });

  it("marks a subject with an unknown version unreadable", async () => {
    const v2 = { ...event(), envelope: "ledger/v2" };
    const snap = await load({ [eventPath(layout, event())]: serializeEvent(v2) });
    const s = snap.subjects.get(S);
    expect(s?.readable).toBe(false);
    expect(s?.events[0]).toMatchObject({ event: null, versionKnown: false });
    expect(brief(findingsOf(snap))).toEqual([
      ["envelope/unknown-version", eventPath(layout, event()), S],
    ]);
  });

  it("leaves body null for zero or several body files", async () => {
    const two = await load({ ...valid, [`log/items/${S}.md`]: "other" });
    expect(two.subjects.get(S)?.bodyPaths).toEqual([
      `log/items/${S}-widget.md`,
      `log/items/${S}.md`,
    ]);
    expect(two.subjects.get(S)?.body).toBeNull();
    const none = await load(at(event()));
    expect(none.subjects.get(S)?.body).toBeNull();
  });
});
