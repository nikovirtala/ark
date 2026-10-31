import { afterEach, describe, expect, it } from "vitest";
import type { EventEnvelope } from "../envelope/types.js";
import { serializeEvent } from "../envelope/yaml.js";
import { NO_INDEX_NUMBERING, NO_NUMBERING } from "../fold/numbering.js";
import { MemoryTree } from "../git/tree.js";
import { eventPath } from "../identity/layout.js";
import { createUlidFactory } from "../identity/ulid.js";
import type { SourceConfig } from "../sources/config.js";
import type { FetchedSource } from "../sources/fetch.js";
import { readSources } from "../sources/read.js";
import { exampleMachineKind as kind } from "../testing/example-machine-kind.js";
import { TEST_HUMAN } from "../testing/history.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { readSourceLog, readSourceSubjects } from "./source-read.js";

const A = "aaaaaaaa";
const B = "bbbbbbbb";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(o?: Parameters<typeof createTempRepo>[0]): Promise<TempRepo> {
  const r = await createTempRepo(o);
  repos.push(r);
  return r;
}

let seq = 0;
function ev(subject: string, type: string, at: string, data: object): EventEnvelope {
  seq += 1;
  const id = createUlidFactory({ now: () => Date.parse(at), random: (b) => b.fill(seq) })();
  const base = {
    envelope: "ledger/v1",
    kind: "widget",
    schema: "widget/v1",
    id,
    subject,
    type,
    at,
  };
  return { ...base, actor: TEST_HUMAN, data } as EventEnvelope;
}

/** A widget log at `root`: A created and published, B created; with `index`, numbering A as 3. */
function log(root: string, o: { readonly index: boolean }): Record<string, string> {
  const layout = kind.layoutAt(root);
  const events = [
    ev(A, "created", "2026-01-01T00:00:00Z", { title: "Alpha" }),
    ev(A, "published", "2026-01-02T00:00:00Z", { body_sha256: "0".repeat(64) }),
    ev(B, "created", "2026-01-03T00:00:00Z", { title: "Beta" }),
  ];
  return {
    ...Object.fromEntries(events.map((e) => [eventPath(layout, e), serializeEvent(e)])),
    [`${root}/items/${A}-alpha.md`]: "alpha\n",
    [`${root}/items/${B}-beta.md`]: "beta\n",
    ...(o.index ? { [`${root}/index.md`]: `<!-- ledger-index/v1 numbers: ${A}=3 -->\n` } : {}),
  };
}

/** A source repository pushed to a bare remote, and a repository that reads it. */
async function setup(files: Record<string, string>) {
  const src = await repo({ files });
  const commit = (await src.git.resolveCommit("HEAD")) ?? "";
  const remote = await repo({ bare: true });
  await src.git.run(["push", "-q", remote.root, "main"]);
  const main = await repo({ files: { "a.txt": "a\n" } });
  const config = (o: Partial<SourceConfig> = {}): SourceConfig => ({
    name: "platform",
    kind: "widget",
    url: remote.root,
    ref: "main",
    root: null,
    ...o,
  });
  /** Fetches `c` into the cache and returns the pin. */
  const fetch = async (c: SourceConfig): Promise<FetchedSource> => {
    const [r] = await readSources(main.git, [c], { fetch: "network" });
    if (r?.source === undefined || r.source === null) throw new Error("not fetched");
    return r.source;
  };
  return { main, commit, config, fetch };
}

describe("readSourceLog", () => {
  const notFetched = "platform not fetched; run widget sources fetch";

  it("reads an uncached source as an empty log at its root, without numbers or a commit", async () => {
    const { main, config } = await setup(log("log", { index: true }));
    for (const [root, at] of [
      [null, "log"],
      ["docs/widgets", "docs/widgets"],
    ] as const) {
      const r = await readSourceLog(main.git, config({ root }), { kind, notFetched });
      expect(r.tree).toBeInstanceOf(MemoryTree);
      expect(await r.tree.list("")).toEqual([]);
      expect(r.layout).toEqual(kind.layoutAt(at));
      expect(r.numbering).toBe(NO_NUMBERING);
      expect(r.commit).toBeNull();
      expect(r.notes).toEqual([notFetched]);
    }
  });

  it("reads a cached source's pinned tree, numbered from its committed index", async () => {
    const { main, commit, config, fetch } = await setup(log("log", { index: true }));
    await fetch(config());
    const r = await readSourceLog(main.git, config(), { kind, notFetched });
    expect(r.layout).toEqual(kind.layoutAt("log"));
    expect(
      new TextDecoder().decode((await r.tree.read(`log/items/${A}-alpha.md`)) ?? undefined),
    ).toBe("alpha\n");
    expect(r.numbering).toMatchObject({ available: true, reason: "index", ref: null });
    expect(Object.fromEntries(r.numbering.byId)).toEqual({ [A]: 3 });
    expect(r.commit).toBe(commit);
    expect(r.notes).toEqual([]);
  });

  it("reads a cached source at its configured root, without numbers when it has no index", async () => {
    const { main, config, fetch } = await setup(log("docs/widgets", { index: false }));
    const c = config({ root: "docs/widgets" });
    await fetch(c);
    const r = await readSourceLog(main.git, c, { kind, notFetched });
    expect(r.layout).toEqual(kind.layoutAt("docs/widgets"));
    expect(r.numbering).toBe(NO_INDEX_NUMBERING);
    expect(r.notes).toEqual([]);
  });
});

describe("readSourceSubjects", () => {
  const toForeign = (v: { status: string; display: string; title: string; id: string }) => ({
    status: v.status,
    display: v.display,
    title: v.title,
    effective: v.id === A ? B : null,
  });

  it("folds and numbers a cached source into foreign subjects", async () => {
    const { config, fetch } = await setup(log("log", { index: true }));
    const r = await readSourceSubjects(await fetch(config()), kind, toForeign);
    expect(r.root).toBe("log");
    expect(r.empty).toBe(false);
    expect(Object.fromEntries(r.subjects)).toEqual({
      [A]: { status: "published", display: "W-3", title: "Alpha", effective: B },
      [B]: { status: "draft", display: B, title: "Beta", effective: null },
    });
  });

  it("shows ids without a committed index", async () => {
    const { config, fetch } = await setup(log("log", { index: false }));
    const r = await readSourceSubjects(await fetch(config()), kind, toForeign);
    expect(r.subjects.get(A)?.display).toBe(A);
  });

  it("reports a source with no log at its root as empty", async () => {
    const { config, fetch } = await setup(log("log", { index: true }));
    const r = await readSourceSubjects(await fetch(config({ root: "elsewhere" })), kind, toForeign);
    expect(r).toEqual({ subjects: new Map(), root: "elsewhere", empty: true });
  });
});
