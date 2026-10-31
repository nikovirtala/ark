import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsageError } from "../errors.js";
import { Git } from "../git/git.js";
import { refReader, type TreeReader, worktreeReader } from "../git/tree.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { lookupPaths } from "./paths.js";

// Anchor strings are built at run time, so this file holds no literal anchor: "@" stands for
// the keyword and its colon.
const KW = "note";
const a = (s: string) => s.replaceAll("@", `${KW}:`);
const A = "a7c2m9xd";
const B = "b3k8q1zz";
const C = "c9d4e5f6";
const D = "d4e5f6g7";

let r: TempRepo;
let head: string;

beforeAll(async () => {
  r = await createTempRepo({
    files: {
      "src/a.ts": a(`// @${A}\n// @team:${B}\n// @${C}\nconst x = 1;\n// @${D}\n`),
      "src/b.ts": "const y = 2;\n",
      "gone/x.ts": "const z = 3;\n",
      "logs/events/e.ts": a(`// @${A}\n`),
    },
  });
  head = (await r.git.resolveCommit("HEAD")) as string;
  await r.remove("gone");
  await symlink("src", join(r.root, "link"));
  await r.write("new.ts", a(`// @${A}\n`));
  await r.write("staged.ts", "const s = 1;\n");
  await r.stage("staged.ts");
});

afterAll(async () => {
  await r.dispose();
});

const lookup = (
  paths: readonly string[],
  o: { readonly at?: TreeReader; readonly cwd?: string; readonly git?: Git } = {},
) =>
  lookupPaths(o.git ?? r.git, {
    tool: "kit",
    tree: o.at ?? worktreeReader(r.git),
    ref: o.at === undefined ? null : "HEAD",
    commit: o.at === undefined ? null : head,
    ...(o.cwd === undefined ? {} : { cwd: o.cwd }),
    paths,
    keyword: KW,
    excludeDirs: ["logs"],
    globSubjects: [{ id: A, globs: ["src/**"] }],
    known: (id) => id === A || id === D,
  });

const usage = async (p: Promise<unknown>, message: string) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(UsageError);
  expect((e as Error).message).toBe(message);
};

describe("lookupPaths", () => {
  it("takes 1 to 100 paths of at most 4096 characters inside the repository", async () => {
    await usage(lookup([]), "kit for takes 1 to 100 paths");
    await usage(
      lookup(Array.from({ length: 101 }, () => "src/a.ts")),
      "kit for takes 1 to 100 paths",
    );
    expect(await lookup(Array.from({ length: 100 }, () => "src/b.ts"))).toHaveLength(1);
    await usage(lookup(["x".repeat(4097)]), "a path can be at most 4096 characters");
    await usage(lookup(["../x.ts"]), "../x.ts is outside the repository");
  });

  it("needs a work tree", async () => {
    const bare = await Git.openGitDir(r.git.gitDir, { env: r.env });
    await usage(lookup(["src/a.ts"], { git: bare }), "kit for needs a work tree");
  });

  it("refuses a directory in the work tree, only in the index, or at a ref", async () => {
    const dir = (given: string) =>
      `${given} is a directory; kit for takes file paths, for example kit for $(git ls-files ${given})`;
    await usage(lookup(["src"]), dir("src"));
    await usage(lookup(["."]), dir("."));
    await usage(lookup(["gone"]), dir("gone"));
    const at = await refReader(r.git, "HEAD");
    await usage(lookup(["gone"], { at }), dir("gone"));
    expect(await lookup(["src/../link"])).toEqual([
      { path: "link", tracked: false, matches: [], unresolved: [] },
    ]);
  });

  it("resolves paths against cwd and drops duplicates in the given order", async () => {
    const out = await lookup(["b.ts", "../src/a.ts", "./b.ts"], { cwd: join(r.root, "src") });
    expect(out.map((p) => p.path)).toEqual(["src/b.ts", "src/a.ts"]);
  });

  it("tells tracked paths from untracked ones, in the index or the ref's tree", async () => {
    const paths = ["src/b.ts", "new.ts", "staged.ts", "gone/x.ts"];
    const tracked = async (o: { readonly at?: TreeReader }) =>
      (await lookup(paths, o)).map((p) => p.tracked);
    expect(await tracked({})).toEqual([true, false, true, true]);
    expect(await tracked({ at: await refReader(r.git, "HEAD") })).toEqual([
      true,
      false,
      false,
      true,
    ]);
  });

  it("matches globs and anchors of known subjects, and lists the rest as unresolved", async () => {
    const [a, b, n] = await lookup(["src/a.ts", "src/b.ts", "new.ts"]);
    expect(a).toEqual({
      path: "src/a.ts",
      tracked: true,
      matches: [
        {
          source: null,
          id: A,
          via: [
            { type: "glob", glob: "src/**" },
            { type: "anchor", line: 1 },
          ],
        },
        // Known but not in globSubjects: its anchor still matches.
        { source: null, id: D, via: [{ type: "anchor", line: 5 }] },
      ],
      unresolved: [
        { ref: `team:${B}`, line: 2, reason: "other-log" },
        { ref: C, line: 3, reason: "not-found" },
      ],
    });
    expect(b?.matches.map((m) => m.via)).toEqual([[{ type: "glob", glob: "src/**" }]]);
    expect(n?.matches).toEqual([{ source: null, id: A, via: [{ type: "anchor", line: 1 }] }]);
  });

  it("reads anchors from the commit at a ref, leaving out excludeDirs", async () => {
    const at = await refReader(r.git, "HEAD");
    const [e, n] = await lookup(["logs/events/e.ts", "new.ts"], { at });
    expect(e?.matches).toEqual([]);
    expect(n).toEqual({ path: "new.ts", tracked: false, matches: [], unresolved: [] });
  });
});
