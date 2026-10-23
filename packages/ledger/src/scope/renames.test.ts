import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { escapeGlob, parseGlob } from "./glob.js";
import { followRenames, type Rename, stagedRenames } from "./renames.js";

/** `before` with `renames` applied, plus `added`. */
const afterOf = (before: readonly string[], renames: readonly Rename[], added: string[] = []) => {
  const moved = new Map(renames.map((r) => [r.from, r.to]));
  return [...before.map((f) => moved.get(f) ?? f), ...added].sort();
};

describe("followRenames", () => {
  it("rewrites a whole-directory move, escapes included", () => {
    const before = ["src/a[1]/x.ts", "src/a[1]/y/z.ts", "src/b.ts"];
    const renames = [
      { from: "src/a[1]/x.ts", to: "src/c[2]/x.ts" },
      { from: "src/a[1]/y/z.ts", to: "src/c[2]/y/z.ts" },
    ];
    expect(
      followRenames({
        globs: ["src/a\\[1\\]/**"],
        renames,
        before,
        after: afterOf(before, renames),
      }),
    ).toEqual({
      globs: ["src/c\\[2\\]/**"],
      changed: true,
      rewritten: [{ from: "src/a\\[1\\]/**", to: ["src/c\\[2\\]/**"] }],
      gained: [],
      skipped: [],
    });
  });

  it("keeps the old glob when a new file appears under the old prefix", () => {
    const before = ["src/orders/a.ts", "src/orders/b.ts", "README.md"];
    const renames = [
      { from: "src/orders/a.ts", to: "src/billing/a.ts" },
      { from: "src/orders/b.ts", to: "src/billing/b.ts" },
    ];
    const r = followRenames({
      globs: ["src/orders/**"],
      renames,
      before,
      after: afterOf(before, renames, ["src/orders/new.ts"]),
    });
    expect(r.globs).toEqual(["src/billing/**", "src/orders/**"]);
    expect(r.gained).toEqual([]);
  });

  it("follows a literal and keeps it when a new file takes the old path", () => {
    const before = ["src/a.ts"];
    const renames = [{ from: "src/a.ts", to: "lib/a.ts" }];
    expect(
      followRenames({ globs: ["src/a.ts"], renames, before, after: afterOf(before, renames) })
        .globs,
    ).toEqual(["lib/a.ts"]);
    const r = followRenames({
      globs: ["src/a.ts"],
      renames,
      before,
      after: afterOf(before, renames, ["src/a.ts"]),
    });
    expect(r.globs).toEqual(["lib/a.ts", "src/a.ts"]);
    expect(r.rewritten).toEqual([{ from: "src/a.ts", to: ["src/a.ts", "lib/a.ts"] }]);
  });

  it("adds escaped literals for a partial move and drops a glob left matching nothing", () => {
    const before = ["src/orders/a.ts", "src/orders/b.ts", "docs/x.md"];
    const renames = [
      { from: "src/orders/a.ts", to: "lib/{a}.ts" },
      { from: "docs/x.md", to: "docs/x.txt" },
    ];
    const r = followRenames({
      globs: ["src/orders/**", "**/*.md"],
      renames,
      before,
      after: afterOf(before, renames),
    });
    expect(r.globs).toEqual(["docs/x.txt", "lib/\\{a\\}.ts", "src/orders/**"]);
    expect(r.rewritten).toEqual([
      { from: "src/orders/**", to: ["src/orders/**", "lib/\\{a\\}.ts"] },
      { from: "**/*.md", to: ["docs/x.txt"] },
    ]);
  });

  it("skips a covered rename whose target can't be a glob", () => {
    const before = ["src/a.ts", "lib/b.ts"];
    const renames = [
      { from: "src/a.ts", to: "src/a\tb.ts" },
      { from: "lib/b.ts", to: "lib/b\t.ts" },
    ];
    expect(
      followRenames({ globs: ["src/a.ts"], renames, before, after: afterOf(before, renames) }),
    ).toEqual({
      globs: ["src/a.ts"],
      changed: false,
      rewritten: [],
      gained: [],
      skipped: [{ from: "src/a.ts", to: "src/a\tb.ts", problem: "control-char" }],
    });
  });

  it("reports files moved into a covered directory as gained", () => {
    const before = ["src/a.ts", "lib/x.ts"];
    const renames = [{ from: "lib/x.ts", to: "src/x.ts" }];
    const r = followRenames({
      globs: ["src/**"],
      renames,
      before,
      after: afterOf(before, renames),
    });
    expect(r).toMatchObject({ globs: ["src/**"], changed: false, gained: ["src/x.ts"] });
  });

  it("keeps invalid globs and globs no rename touches", () => {
    const before = ["a/x.ts"];
    const renames = [{ from: "a/x.ts", to: "b/x.ts" }];
    const r = followRenames({
      globs: ["c/**", "bad/"],
      renames,
      before,
      after: afterOf(before, renames),
    });
    expect(r).toMatchObject({ globs: ["bad/", "c/**"], changed: false, rewritten: [] });
  });

  it("never loses coverage and reports exactly the gained files", () => {
    const DIRS = ["src", "lib", "a[1]", "!notes", "w{x}"] as const;
    const NAMES = ["a.ts", "b.md", "c[1].ts", "*x.ts", "!y.md", "{z}.ts", "sub/d.ts"] as const;
    const arbFile = fc
      .tuple(fc.constantFrom(...DIRS), fc.constantFrom(...NAMES))
      .map(([d, n]) => `${d}/${n}`);
    const arbOp = fc.oneof(
      fc.record({
        kind: fc.constant("file" as const),
        file: fc.nat(),
        dir: fc.constantFrom(...DIRS),
      }),
      fc.record({
        kind: fc.constant("dir" as const),
        from: fc.constantFrom(...DIRS),
        to: fc.constantFrom(...DIRS, "moved", "src/deep"),
      }),
    );
    const arbAdd = fc.oneof(
      fc.record({ kind: fc.constant("old-path" as const), i: fc.nat() }),
      fc.record({ kind: fc.constant("old-dir" as const), i: fc.nat() }),
      fc.record({ kind: fc.constant("elsewhere" as const), name: fc.constantFrom(...NAMES) }),
    );
    const arbCase = fc.uniqueArray(arbFile, { minLength: 1, maxLength: 30 }).chain((before) => {
      const dirsOf = [...new Set(before.map((f) => f.split("/")[0] as string))];
      const candidates = [
        ...before.map(escapeGlob),
        ...dirsOf.flatMap((d) => [`${escapeGlob(d)}/**`, `${escapeGlob(d)}/*.ts`]),
        "**/*.md",
        "**/sub/**",
        "**",
      ];
      return fc.record({
        before: fc.constant(before),
        globs: fc.subarray(candidates, { minLength: 1, maxLength: Math.min(5, candidates.length) }),
        ops: fc.array(arbOp, { maxLength: 4 }),
        adds: fc.array(arbAdd, { maxLength: 3 }),
      });
    });

    fc.assert(
      fc.property(arbCase, ({ before, globs, ops, adds }) => {
        // Apply the operations to an origin → destination map, skipping collisions.
        const dest = new Map(before.map((f) => [f, f]));
        const taken = () => new Set(dest.values());
        const move = (origin: string, to: string) => {
          if (to !== dest.get(origin) && !taken().has(to)) dest.set(origin, to);
        };
        for (const op of ops) {
          if (op.kind === "file") {
            const origin = before[op.file % before.length] as string;
            const name = (dest.get(origin) as string).split("/").slice(1).join("/");
            move(origin, `${op.dir}/${name}`);
          } else {
            for (const origin of before) {
              const cur = dest.get(origin) as string;
              if (cur.startsWith(`${op.from}/`))
                move(origin, `${op.to}${cur.slice(op.from.length)}`);
            }
          }
        }
        const renames = before
          .filter((f) => dest.get(f) !== f)
          .map((f) => ({ from: f, to: dest.get(f) as string }));
        const after = new Set(dest.values());
        for (const add of adds) {
          let path: string | null = null;
          if (add.kind === "old-path" && renames.length > 0) {
            path = (renames[add.i % renames.length] as Rename).from;
          } else if (add.kind === "old-dir" && renames.length > 0) {
            const from = (renames[add.i % renames.length] as Rename).from;
            path = `${from.split("/")[0]}/new.ts`;
          } else if (add.kind === "elsewhere") {
            path = `other/${add.name}`;
          }
          if (path !== null) after.add(path);
        }

        const r = followRenames({ globs, renames, before, after: [...after].sort() });
        const parsed = r.globs.map((g) => parseGlob(g));
        expect(parsed.every((p) => p.ok)).toBe(true);
        const oldG = globs.map((g) => parseGlob(g)).flatMap((p) => (p.ok ? [p.glob] : []));
        const newG = parsed.flatMap((p) => (p.ok ? [p.glob] : []));
        const origin = new Map(renames.map((x) => [x.to, x.from]));
        const gained: string[] = [];
        for (const f of after) {
          const was = oldG.some((g) => g.matches(origin.get(f) ?? f));
          const is = newG.some((g) => g.matches(f));
          if (was) expect(is, `${f} lost coverage`).toBe(true);
          if (is && !was) gained.push(f);
        }
        expect(r.gained).toEqual(gained.sort());
        expect(r.skipped).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});

describe("stagedRenames", () => {
  const repos: TempRepo[] = [];
  afterEach(async () => {
    for (const r of repos.splice(0)) await r.dispose();
  });

  it("returns [] on an unborn HEAD", async () => {
    const r = await createTempRepo();
    repos.push(r);
    await r.write("a.ts", "x\n");
    await r.stage("a.ts");
    expect(await stagedRenames(r.git)).toEqual([]);
  });

  it("lists the staged renames after git mv of a directory", async () => {
    const content = (n: number) => `${"line\n".repeat(20)}${n}\n`;
    const r = await createTempRepo({
      files: {
        "src/orders/a.ts": content(1),
        "src/orders/b c.ts": content(2),
        "keep.ts": content(3),
      },
    });
    repos.push(r);
    expect(await stagedRenames(r.git)).toEqual([]);
    await r.git.run(["mv", "src/orders", "src/billing"]);
    await r.write("keep.ts", "changed\n");
    await r.stage("keep.ts");
    expect(await stagedRenames(r.git)).toEqual([
      { from: "src/orders/a.ts", to: "src/billing/a.ts" },
      { from: "src/orders/b c.ts", to: "src/billing/b c.ts" },
    ]);
  });
});
