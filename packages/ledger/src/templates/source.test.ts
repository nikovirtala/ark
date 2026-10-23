import { afterEach, describe, expect, it } from "vitest";
import { MemoryTree, type TreeReader, worktreeReader } from "../git/tree.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { gitTemplates, historyTemplates, treeTemplates } from "./source.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});

function templateText(version: number, heading = "Context"): string {
  return `---
template: lite
version: ${version}
sections:
  - id: context
    heading: ${heading}
    required: true
---
# {{title}}

## ${heading}
{{context}}
`;
}

const PATH = "log/templates/lite.md";

/** A tree that counts its reads. */
function counting(tree: TreeReader): { tree: TreeReader; reads: () => number } {
  let n = 0;
  return {
    tree: {
      label: tree.label,
      commit: tree.commit,
      list: (p) => tree.list(p),
      read: (p) => {
        n++;
        return tree.read(p);
      },
      readMany: (ps) => tree.readMany(ps),
    },
    reads: () => n,
  };
}

describe("treeTemplates", () => {
  it("finds the current version by file name", async () => {
    const source = treeTemplates(new MemoryTree({ [PATH]: templateText(2) }), "log/templates/");
    const found = await source.get("lite", 2);
    expect(found.ok && found.template).toMatchObject({ name: "lite", version: 2, path: PATH });
  });

  it("reports a missing file, another version, an invalid file and an unusable name", async () => {
    const source = treeTemplates(
      new MemoryTree({
        [PATH]: templateText(2),
        "log/templates/broken.md": "no frontmatter\n",
        "log/templates/binary.md": new Uint8Array([0xff]),
      }),
      "log/templates",
    );
    expect(await source.get("lite", 1)).toEqual({
      ok: false,
      reason: "version-not-found",
      path: PATH,
    });
    expect(await source.get("nygard", 1)).toEqual({
      ok: false,
      reason: "not-found",
      path: "log/templates/nygard.md",
    });
    expect(await source.get("broken", 1)).toMatchObject({ ok: false, reason: "version-not-found" });
    expect(await source.get("binary", 1)).toMatchObject({ ok: false, reason: "version-not-found" });
    expect(await source.get("../lite", 2)).toMatchObject({ ok: false, reason: "not-found" });
  });

  it("memoizes per name and version", async () => {
    const c = counting(new MemoryTree({ [PATH]: templateText(2) }));
    const source = treeTemplates(c.tree, "log/templates");
    await Promise.all([source.get("lite", 2), source.get("lite", 2)]);
    await source.get("lite", 2);
    expect(c.reads()).toBe(1);
    await source.get("lite", 1);
    expect(c.reads()).toBe(2);
  });
});

describe("historyTemplates", () => {
  it("falls back to the ref's history for an older version", async () => {
    const r = await createTempRepo();
    repos.push(r);
    await r.write(PATH, templateText(1, "Background"));
    await r.stage(PATH);
    await r.commit("lite v1");
    await r.write(PATH, templateText(2));
    await r.commit("lite v2", { all: true });

    const tree = worktreeReader(r.git);
    const source = historyTemplates(r.git, tree, "log/templates", { ref: "HEAD" });
    const v1 = await source.get("lite", 1);
    expect(v1.ok && v1.template.sections[0]?.heading).toBe("Background");
    const v2 = await source.get("lite", 2);
    expect(v2.ok && v2.template.version).toBe(2);
    expect(await source.get("lite", 3)).toEqual({
      ok: false,
      reason: "version-not-found",
      path: PATH,
    });

    const factory = gitTemplates(r.git, { historyRef: "HEAD" });
    expect(await factory(tree, "log/templates").get("lite", 1)).toEqual(v1);
  });

  it("finds a template only in history when the head tree no longer has it", async () => {
    const r = await createTempRepo({ files: { [PATH]: templateText(1) } });
    repos.push(r);
    const found = await historyTemplates(r.git, new MemoryTree({}), "log/templates", {
      ref: "HEAD",
    }).get("lite", 1);
    expect(found.ok).toBe(true);
    expect(
      await historyTemplates(r.git, new MemoryTree({}), "log/templates", { ref: "HEAD" }).get(
        "gone",
        1,
      ),
    ).toEqual({ ok: false, reason: "not-found", path: "log/templates/gone.md" });
  });

  it("skips the history lookup without a ref (unborn HEAD)", async () => {
    const r = await createTempRepo();
    repos.push(r);
    const tree = new MemoryTree({ [PATH]: templateText(2) });
    const source = historyTemplates(r.git, tree, "log/templates", { ref: null });
    expect((await source.get("lite", 2)).ok).toBe(true);
    expect(await source.get("lite", 1)).toMatchObject({ ok: false, reason: "version-not-found" });
  });
});
