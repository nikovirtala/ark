import { readdirSync, readFileSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// adr's import rules (design §5.1):
// - kind.ts and kind/** import only @nikovirtala/ledger and ./kind/**, so the ./kind entry stays
//   free of CLI and MCP code;
// - only cli.ts and cli/** import @nikovirtala/ledger/cli or ./cli/**;
// - only tests and test-support/** import @nikovirtala/ledger/testing or ./test-support/**.

const SPECIFIER = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const isTest = (file: string) => file.endsWith(".test.ts");
const isKindFile = (file: string) => file === "kind.ts" || file.startsWith("kind/");
const isCliFile = (file: string) => file === "cli.ts" || file.startsWith("cli/");
const isTestSupport = (file: string) => file.startsWith("test-support/");

/** Import targets: relative ones as src-relative `.ts` paths, packages as given. */
function importsOf(file: string, source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((m) => {
    const spec = m[1] ?? "";
    if (!spec.startsWith(".")) return spec;
    const resolved = posix.normalize(posix.join(posix.dirname(file), spec));
    return resolved.endsWith(".js") ? `${resolved.slice(0, -3)}.ts` : resolved;
  });
}

/** The §5.1 rules over a map of src-relative file → its import targets. */
function violations(graph: ReadonlyMap<string, readonly string[]>): string[] {
  const out: string[] = [];
  for (const [file, targets] of graph) {
    for (const target of targets) {
      if (isKindFile(file) && !isTest(file)) {
        const ok = target === "@nikovirtala/ledger" || target.startsWith("kind/");
        if (!ok)
          out.push(
            `${file}: the kind may import only @nikovirtala/ledger and kind/, not ${target}`,
          );
      }
      if (!isCliFile(file) && (target === "@nikovirtala/ledger/cli" || isCliFile(target))) {
        out.push(`${file}: only cli.ts and cli/ may import ${target}`);
      }
      const testOnly = target === "@nikovirtala/ledger/testing" || isTestSupport(target);
      if (testOnly && !isTest(file) && !isTestSupport(file)) {
        out.push(`${file}: only tests and test-support/ may import ${target}`);
      }
    }
  }
  return out;
}

const src = fileURLToPath(new URL(".", import.meta.url));

function sourceGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const entry of readdirSync(src, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const file = relative(src, join(entry.parentPath, entry.name)).split("\\").join("/");
    graph.set(file, importsOf(file, readFileSync(join(src, file), "utf8")));
  }
  return graph;
}

describe("adr layering", () => {
  it("holds for the sources", () => {
    const graph = sourceGraph();
    expect(graph.has("kind.ts")).toBe(true);
    expect(violations(graph)).toEqual([]);
  });

  it("reports each rule on a synthetic graph", () => {
    const graph = new Map<string, string[]>([
      ["kind.ts", ["@nikovirtala/ledger", "kind/schemas.ts", "log.ts"]],
      ["kind/rules.ts", ["@nikovirtala/ledger/cli", "kind/reduce.ts"]],
      ["log.ts", ["cli/text.ts", "@nikovirtala/ledger"]],
      ["views.ts", ["@nikovirtala/ledger/testing", "test-support/events.ts"]],
      ["cli/list.ts", ["@nikovirtala/ledger/cli", "log.ts"]],
      ["cli.ts", ["cli/commands.ts"]],
      ["test-support/events.ts", ["@nikovirtala/ledger/testing", "kind.ts"]],
      ["kind/project.test.ts", ["test-support/events.ts", "@nikovirtala/ledger/testing"]],
    ]);
    expect(violations(graph)).toEqual([
      "kind.ts: the kind may import only @nikovirtala/ledger and kind/, not log.ts",
      "kind/rules.ts: the kind may import only @nikovirtala/ledger and kind/, not @nikovirtala/ledger/cli",
      "kind/rules.ts: only cli.ts and cli/ may import @nikovirtala/ledger/cli",
      "log.ts: only cli.ts and cli/ may import cli/text.ts",
      "views.ts: only tests and test-support/ may import @nikovirtala/ledger/testing",
      "views.ts: only tests and test-support/ may import test-support/events.ts",
    ]);
  });
});
