import { afterEach, describe, expect, it } from "vitest";
import { InvalidArgumentError, RefNotFoundError } from "../errors.js";
import { MemoryTree } from "../git/tree.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { findTemplateVersion, loadTemplates } from "./history.js";

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

describe("loadTemplates", () => {
  it("reads the templates directly in a directory, keyed by name", async () => {
    const tree = new MemoryTree({
      "docs/adr/templates/lite.md": templateText(2),
      "docs/adr/templates/broken.md": "# no frontmatter\n",
      "docs/adr/templates/README.txt": "not a template",
      "docs/adr/templates/old/lite.md": templateText(1),
      "docs/adr/templates/bad.md": new Uint8Array([0xff]),
    });
    const { templates, findings } = await loadTemplates(tree, "docs/adr/templates/");
    expect([...templates.keys()]).toEqual(["lite"]);
    expect(templates.get("lite")).toMatchObject({
      version: 2,
      path: "docs/adr/templates/lite.md",
    });
    expect(findings.map((f) => [f.file, f.rule])).toEqual([
      ["docs/adr/templates/bad.md", "template/frontmatter"],
      ["docs/adr/templates/broken.md", "template/frontmatter"],
    ]);
  });
});

describe("findTemplateVersion", () => {
  it("finds an old version in history and returns null for an unknown one", async () => {
    const r = await createTempRepo();
    repos.push(r);
    const path = "templates/lite.md";
    await r.write(path, templateText(1, "Background"));
    await r.stage(path);
    const v1 = await r.commit("add lite v1");
    await r.write(path, templateText(2));
    await r.commit("bump lite to v2", { all: true });
    await r.write("other.txt", "x\n");
    await r.stage("other.txt");
    await r.commit("unrelated");

    const t1 = await findTemplateVersion(r.git, path, 1);
    expect(t1).toMatchObject({ name: "lite", version: 1, path });
    expect(t1?.sections[0]?.heading).toBe("Background");
    expect((await findTemplateVersion(r.git, path, 2))?.sections[0]?.heading).toBe("Context");
    expect(await findTemplateVersion(r.git, path, 3)).toBeNull();
    expect(await findTemplateVersion(r.git, path, 2, { ref: v1 })).toBeNull();
    expect(await findTemplateVersion(r.git, "templates/none.md", 1)).toBeNull();
    // Memoized per commit, path and version.
    expect(await findTemplateVersion(r.git, path, 1)).toBe(t1);
  });

  it("finds a version that only existed on a merged side branch", async () => {
    const r = await createTempRepo();
    repos.push(r);
    const path = "templates/lite.md";
    await r.write(path, templateText(1));
    await r.stage(path);
    await r.commit("add lite v1");
    await r.checkout("side", { create: true });
    await r.write(path, templateText(2, "Side"));
    await r.commit("lite v2 on side", { all: true });
    await r.checkout("main");
    await r.write(path, templateText(3));
    await r.commit("lite v3 on main", { all: true });
    // The merge keeps main's file, so default history simplification would prune the side.
    await r.git.run(["merge", "-q", "-s", "ours", "--no-edit", "side"]);

    expect((await findTemplateVersion(r.git, path, 1))?.version).toBe(1);
    expect((await findTemplateVersion(r.git, path, 2))?.sections[0]?.heading).toBe("Side");
    expect((await findTemplateVersion(r.git, path, 3))?.version).toBe(3);
  });

  it("rejects unknown and option-like refs", async () => {
    const r = await createTempRepo({ files: { "a.txt": "a\n" } });
    repos.push(r);
    await expect(findTemplateVersion(r.git, "a.md", 1, { ref: "nope" })).rejects.toBeInstanceOf(
      RefNotFoundError,
    );
    await expect(findTemplateVersion(r.git, "a.md", 1, { ref: "-x" })).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
  });
});
