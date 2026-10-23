import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Layer ranks, bottom up (design §3). A layer file may import only equal or lower ranks; the
// testing harness sits on top and may import any layer but the other entries.
const RANKS: readonly [prefix: string, rank: number][] = [
  ["errors.ts", 0],
  ["findings/", 0],
  ["git/", 1],
  ["identity/", 2],
  ["envelope/", 3],
  ["templates/", 4],
  ["log/", 5],
  ["kind/", 6],
  ["fold/", 7],
  ["verify/", 8],
  ["sources/", 9],
  ["scope/", 10],
  ["log-index/", 11],
  ["hooks/", 12],
  ["surfaces/", 13],
  ["cli/", 14],
  ["mcp/", 15],
  ["testing/", 16],
];
const TESTING_RANK = 16;
const ENTRY = "index.ts";
// The other entries' directories. The root entry imports none of them, and none imports another,
// so importing a kind never loads CLI, MCP or test code.
const ENTRY_DIRS = ["cli/", "mcp/", "testing/"] as const;

const entryDirOf = (file: string) => ENTRY_DIRS.find((d) => file.startsWith(d)) ?? null;

function rankOf(file: string): number | null {
  for (const [prefix, rank] of RANKS) {
    if (prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix) return rank;
  }
  return null;
}

const SPECIFIER = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

/** Relative import targets of a source file, as src-relative `.ts` paths (or the raw specifier). */
function importsOf(file: string, source: string): string[] {
  const targets: string[] = [];
  for (const m of source.matchAll(SPECIFIER)) {
    const spec = m[1] ?? "";
    if (!spec.startsWith(".")) continue;
    const resolved = posix.normalize(posix.join(posix.dirname(file), spec));
    targets.push(resolved.endsWith(".js") ? `${resolved.slice(0, -3)}.ts` : resolved);
  }
  return targets;
}

/** Applies the §3 rules to a map of src-relative file → its relative import targets. */
function violations(graph: ReadonlyMap<string, readonly string[]>): string[] {
  const out: string[] = [];
  for (const [file, targets] of graph) {
    const rank = rankOf(file);
    if (file !== ENTRY && rank === null) {
      out.push(`${file}: not in any layer; add it to a layer directory`);
      continue;
    }
    for (const target of targets) {
      if (!target.endsWith(".ts")) {
        out.push(`${file}: relative import ${target} must use a .js specifier`);
        continue;
      }
      if (!graph.has(target)) {
        out.push(`${file}: imports ${target}, which is not a non-test source file`);
        continue;
      }
      if (file === ENTRY) {
        if (entryDirOf(target) !== null) out.push(`${file}: must not import ${target}`);
        continue;
      }
      if (target === ENTRY) {
        out.push(`${file}: must not import the root entry ${ENTRY}`);
        continue;
      }
      const fileEntry = entryDirOf(file);
      const targetEntry = entryDirOf(target);
      if (fileEntry !== null && targetEntry !== null && targetEntry !== fileEntry) {
        out.push(`${file}: must not import ${target}`);
        continue;
      }
      const targetRank = rankOf(target);
      if (rank !== null && rank < TESTING_RANK && targetRank !== null && targetRank > rank) {
        out.push(`${file} (rank ${rank}) imports ${target} (rank ${targetRank})`);
      }
    }
  }
  return out;
}

function sourceGraph(srcDir: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const entry of readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    const abs = join(entry.parentPath, entry.name);
    const file = relative(srcDir, abs).split("\\").join("/");
    graph.set(file, importsOf(file, readFileSync(abs, "utf8")));
  }
  return graph;
}

describe("layering", () => {
  it("every source file imports only equal or lower layers", () => {
    const graph = sourceGraph(dirname(fileURLToPath(import.meta.url)));
    expect(graph.has(ENTRY)).toBe(true);
    expect(graph.has("testing/index.ts")).toBe(true);
    expect(violations(graph)).toEqual([]);
  });

  it("maps .js specifiers back to .ts sources", () => {
    expect(
      importsOf(
        "git/tree.ts",
        'import { a } from "./git.js";\nimport type { E } from "../errors.js";\nexport { b } from "../findings/finding.js";\nimport fs from "node:fs";\nawait import("../identity/ids.js");',
      ),
    ).toEqual(["git/git.ts", "errors.ts", "findings/finding.ts", "identity/ids.ts"]);
  });

  it("keeps the cli entry out of the root entry", () => {
    const graph = sourceGraph(dirname(fileURLToPath(import.meta.url)));
    expect(graph.has("cli/index.ts")).toBe(true);
    expect(graph.get(ENTRY)?.filter((t) => t.startsWith("cli/"))).toEqual([]);
  });

  it("catches each kind of violation", () => {
    const graph = new Map<string, string[]>([
      ["index.ts", ["errors.ts", "testing/index.ts", "cli/index.ts", "surfaces/a.ts"]],
      ["errors.ts", []],
      ["git/git.ts", ["errors.ts", "identity/ids.ts", "index.ts"]],
      ["identity/ids.ts", ["git/git.ts", "../outside"]],
      ["testing/index.ts", ["hooks/x.ts", "index.ts"]],
      ["hooks/x.ts", ["testing/index.ts"]],
      ["kind/define.ts", ["log/snapshot.ts", "fold/fold.ts"]],
      ["log/snapshot.ts", []],
      ["fold/fold.ts", []],
      ["surfaces/a.ts", ["fold/fold.ts"]],
      ["cli/index.ts", ["cli/run.ts", "surfaces/a.ts", "errors.ts"]],
      ["cli/run.ts", ["index.ts", "testing/index.ts", "mcp/index.ts"]],
      ["mcp/index.ts", ["cli/run.ts", "surfaces/a.ts"]],
      ["testing/x.ts", ["cli/index.ts", "mcp/index.ts", "testing/index.ts", "surfaces/a.ts"]],
      ["stray.ts", []],
    ]);
    expect(violations(graph)).toEqual([
      "index.ts: must not import testing/index.ts",
      "index.ts: must not import cli/index.ts",
      "git/git.ts (rank 1) imports identity/ids.ts (rank 2)",
      "git/git.ts: must not import the root entry index.ts",
      "identity/ids.ts: relative import ../outside must use a .js specifier",
      "testing/index.ts: must not import the root entry index.ts",
      "hooks/x.ts (rank 12) imports testing/index.ts (rank 16)",
      "kind/define.ts (rank 6) imports fold/fold.ts (rank 7)",
      "cli/run.ts: must not import the root entry index.ts",
      "cli/run.ts: must not import testing/index.ts",
      "cli/run.ts: must not import mcp/index.ts",
      "mcp/index.ts: must not import cli/run.ts",
      "testing/x.ts: must not import cli/index.ts",
      "testing/x.ts: must not import mcp/index.ts",
      "stray.ts: not in any layer; add it to a layer directory",
    ]);
  });
});
