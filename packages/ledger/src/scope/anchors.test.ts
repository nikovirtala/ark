import { afterEach, describe, expect, it } from "vitest";
import { InvalidArgumentError } from "../errors.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { anchorsInLine, scanAnchors } from "./anchors.js";

// Anchor strings are built at run time, so this file holds no literal anchor: "@" stands for
// the keyword and its colon.
const KW = "adr";
const a = (s: string) => s.replaceAll("@", `${KW}:`);
const ID = "k3f9q8a1";
const ID2 = "7m2x9c4d";

describe("anchorsInLine", () => {
  it.each([
    [`// @${ID}`, null],
    [`# @${ID}`, null],
    [`/* @${ID} */`, null],
    [`-- @${ID}`, null],
    [`; @${ID}`, null],
    [`% @${ID}`, null],
    [`<!-- @${ID} -->`, null],
    [`(* @${ID} *)`, null],
    [` * @${ID}`, null],
    [`*@${ID}`, null],
    [`const x = 1; // see @${ID}`, null],
    [`//@${ID}`, null],
    [`--@${ID}`, null],
    [`<!--@${ID}-->`, null],
    [`  //@${ID}`, null],
    [`# @platform:${ID}`, "platform"],
    [`// @abcdefgh:${ID}`, "abcdefgh"],
    [`// @${ID}: keep in sync`, null],
    [`// @${ID}.`, null],
    [`// (@${ID})`, null],
  ])("finds the anchor in %j", (line, source) => {
    expect(anchorsInLine(a(line), KW)).toEqual([
      { source, id: ID, column: a(line).indexOf(`${KW}:`) + 1 },
    ]);
  });

  it.each([
    "@//decision/7",
    `to: @${ID}`,
    `see @${ID} in prose`,
    `// x@${ID}`,
    `http://@${ID}`,
    `x//@${ID}`,
    `<!--@${ID}-x`,
    `// @${ID}:zz`,
    `// @${ID}x`,
    `// @${ID}_`,
    `// @${ID.slice(0, 7)}`,
    `// @K3F9Q8A1`,
    `// @k3f9q8i1`,
    `// a.@${ID}`,
    `// a/@${ID}`,
    `// a:@${ID}`,
    `// a-@${ID}`,
    `@${ID} // after the token`,
  ])("finds no anchor in %j", (line) => {
    expect(anchorsInLine(a(line), KW)).toEqual([]);
  });

  it("finds several anchors on one line, and only for the keyword", () => {
    expect(anchorsInLine(a(`// @${ID}, @team:${ID2} and issue:${ID2}`), KW)).toEqual([
      { source: null, id: ID, column: 4 },
      { source: "team", id: ID2, column: 18 },
    ]);
    expect(anchorsInLine(`# issue:${ID2}`, "issue")).toEqual([
      { source: null, id: ID2, column: 3 },
    ]);
  });
});

describe("scanAnchors", () => {
  const repos: TempRepo[] = [];
  afterEach(async () => {
    for (const r of repos.splice(0)) await r.dispose();
  });

  async function repo() {
    const r = await createTempRepo({
      files: {
        "src/a.ts": a(`const x = 1;\n// @${ID}\n// @${ID2} and @lib:${ID}\n`),
        "src/b.py": a(`# nothing here\n`),
        "docs/x.md": a(`<!-- @${ID} -->\n`),
        "docs/adr/events/x.yaml": a(`# @${ID}\n`),
        "odd\nname.sh": a(`# @${ID2}\n`),
      },
    });
    repos.push(r);
    const binary = new TextEncoder().encode(a(`\0// @${ID}\n`));
    await r.write("bin.dat", binary);
    await r.stage("bin.dat");
    await r.commit("add a binary");
    return r;
  }

  it("scans the work tree, untracked files included", async () => {
    const r = await repo();
    await r.write("new.ts", a(`\n\n// @${ID2}\n`));
    expect(await scanAnchors(r.git, { keyword: KW, tree: "worktree" })).toEqual([
      { path: "docs/adr/events/x.yaml", line: 1, source: null, id: ID },
      { path: "docs/x.md", line: 1, source: null, id: ID },
      { path: "new.ts", line: 3, source: null, id: ID2 },
      { path: "odd\nname.sh", line: 1, source: null, id: ID2 },
      { path: "src/a.ts", line: 2, source: null, id: ID },
      { path: "src/a.ts", line: 3, source: null, id: ID2 },
      { path: "src/a.ts", line: 3, source: "lib", id: ID },
    ]);
  });

  it("skips excluded directories and files matched by exclude globs", async () => {
    const r = await repo();
    const found = await scanAnchors(r.git, {
      keyword: KW,
      tree: "worktree",
      excludeDirs: ["docs/adr"],
      exclude: ["**/*.md", "odd*"],
    });
    expect(found.map((x) => x.path)).toEqual(["src/a.ts", "src/a.ts", "src/a.ts"]);
    const only = await scanAnchors(r.git, { keyword: KW, tree: "worktree", paths: ["docs"] });
    expect(only.map((x) => x.path)).toEqual(["docs/adr/events/x.yaml", "docs/x.md"]);
  });

  it("scans the index and a commit", async () => {
    const r = await repo();
    const head = await r.git.resolveCommit("HEAD");
    await r.write("src/a.ts", a(`// @${ID2}\n`));
    await r.write("src/b.py", a(`x = 1\n# @${ID}\n`));
    await r.stage("src/b.py");
    const paths = ["src"];
    expect(await scanAnchors(r.git, { keyword: KW, tree: "index", paths })).toEqual([
      { path: "src/a.ts", line: 2, source: null, id: ID },
      { path: "src/a.ts", line: 3, source: null, id: ID2 },
      { path: "src/a.ts", line: 3, source: "lib", id: ID },
      { path: "src/b.py", line: 2, source: null, id: ID },
    ]);
    expect(await scanAnchors(r.git, { keyword: KW, tree: { commit: head ?? "" }, paths })).toEqual([
      { path: "src/a.ts", line: 2, source: null, id: ID },
      { path: "src/a.ts", line: 3, source: null, id: ID2 },
      { path: "src/a.ts", line: 3, source: "lib", id: ID },
    ]);
    expect(await scanAnchors(r.git, { keyword: KW, tree: "worktree", paths })).toEqual([
      { path: "src/a.ts", line: 1, source: null, id: ID2 },
      { path: "src/b.py", line: 2, source: null, id: ID },
    ]);
  });

  it("returns nothing when nothing matches", async () => {
    const r = await repo();
    expect(await scanAnchors(r.git, { keyword: "issue", tree: "worktree" })).toEqual([]);
    expect(await scanAnchors(r.git, { keyword: KW, tree: "worktree", paths: [] })).toEqual([]);
  });

  it("refuses an invalid keyword, exclude glob or commit", async () => {
    const r = await repo();
    await expect(scanAnchors(r.git, { keyword: "A", tree: "index" })).rejects.toThrow(
      InvalidArgumentError,
    );
    await expect(
      scanAnchors(r.git, { keyword: KW, tree: "index", exclude: ["/abs"] }),
    ).rejects.toThrow('invalid glob "/abs"');
    await expect(scanAnchors(r.git, { keyword: KW, tree: { commit: "-x" } })).rejects.toThrow(
      InvalidArgumentError,
    );
  });
});
