import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Layer ranks, bottom up (design §3). A layer file may import only equal or lower ranks.
const RANKS: readonly [prefix: string, rank: number][] = [
  ["errors.ts", 0],
  ["findings/", 0],
  ["git/", 1],
  ["identity/", 2],
  ["envelope/", 3],
  ["log/", 4],
  ["verify/", 5],
  ["sources/", 6],
  ["templates/", 7],
  ["hooks/", 8],
  ["testing/", 9],
];
const ENTRY = "index.ts";

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
        if (target.startsWith("testing/")) out.push(`${file}: must not import ${target}`);
        continue;
      }
      if (target === ENTRY) {
        out.push(`${file}: must not import the root entry ${ENTRY}`);
        continue;
      }
      const targetRank = rankOf(target);
      if (rank !== null && rank < 9 && targetRank !== null && targetRank > rank) {
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

  it("catches each kind of violation", () => {
    const graph = new Map<string, string[]>([
      ["index.ts", ["errors.ts", "testing/index.ts"]],
      ["errors.ts", []],
      ["git/git.ts", ["errors.ts", "identity/ids.ts", "index.ts"]],
      ["identity/ids.ts", ["git/git.ts", "../outside"]],
      ["testing/index.ts", ["hooks/x.ts", "index.ts"]],
      ["hooks/x.ts", ["testing/index.ts"]],
      ["stray.ts", []],
    ]);
    expect(violations(graph)).toEqual([
      "index.ts: must not import testing/index.ts",
      "git/git.ts (rank 1) imports identity/ids.ts (rank 2)",
      "git/git.ts: must not import the root entry index.ts",
      "identity/ids.ts: relative import ../outside must use a .js specifier",
      "testing/index.ts: must not import the root entry index.ts",
      "hooks/x.ts (rank 8) imports testing/index.ts (rank 9)",
      "stray.ts: not in any layer; add it to a layer directory",
    ]);
  });
});
