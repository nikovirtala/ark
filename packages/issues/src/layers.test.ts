import { readdirSync, readFileSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// issues' import rules (design "Module layout"), copied from adr's layers.test.ts:
// - kind.ts and kind/** import only @nikovirtala/ledger and ./kind/**, so the ./kind entry stays
//   free of CLI and MCP code, and of adr;
// - only cli.ts and cli/** import @nikovirtala/ledger/cli or ./cli/**;
// - only tests and test-support/** import @nikovirtala/ledger/testing or ./test-support/**;
// - the library imports adr only as @nikovirtala/adr/kind; tests and test-support/** may import
//   @nikovirtala/adr to set up decision logs;
// - only mcp/**, tests and test-support/** import @nikovirtala/ledger/mcp or the MCP SDK, and only
//   cli/mcp.ts, tests and test-support/** import ./mcp/**, so only `issues mcp` loads MCP code.

const SPECIFIER = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const isTest = (file: string) => file.endsWith(".test.ts");
const isKindFile = (file: string) => file === "kind.ts" || file.startsWith("kind/");
const isCliFile = (file: string) => file === "cli.ts" || file.startsWith("cli/");
const isTestSupport = (file: string) => file.startsWith("test-support/");
const isAdrPackage = (spec: string) =>
  spec === "@nikovirtala/adr" || spec.startsWith("@nikovirtala/adr/");
const isMcpFile = (file: string) => file.startsWith("mcp/");
const isMcpPackage = (spec: string) =>
  spec === "@nikovirtala/ledger/mcp" || /^@modelcontextprotocol\/sdk(?:\/|$)/.test(spec);

/** Import targets: relative ones as src-relative `.ts` paths, packages as given. */
function importsOf(file: string, source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((m) => {
    const spec = m[1] ?? "";
    if (!spec.startsWith(".")) return spec;
    const resolved = posix.normalize(posix.join(posix.dirname(file), spec));
    return resolved.endsWith(".js") ? `${resolved.slice(0, -3)}.ts` : resolved;
  });
}

/** The rules over a map of src-relative file → its import targets. */
function violations(graph: ReadonlyMap<string, readonly string[]>): string[] {
  const out: string[] = [];
  for (const [file, targets] of graph) {
    const testing = isTest(file) || isTestSupport(file);
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
      if (testOnly && !testing) {
        out.push(`${file}: only tests and test-support/ may import ${target}`);
      }
      if (isAdrPackage(target) && target !== "@nikovirtala/adr/kind" && !testing) {
        out.push(
          `${file}: the library may import adr only as @nikovirtala/adr/kind, not ${target}`,
        );
      }
      if (isMcpPackage(target) && !isMcpFile(file) && !testing) {
        out.push(`${file}: only mcp/ may import ${target}`);
      }
      if (isMcpFile(target) && !isMcpFile(file) && file !== "cli/mcp.ts" && !testing) {
        out.push(`${file}: only cli/mcp.ts may import ${target}`);
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

describe("issues layering", () => {
  it("holds for the sources", () => {
    const graph = sourceGraph();
    expect(graph.has("kind.ts")).toBe(true);
    expect(violations(graph)).toEqual([]);
  });

  it("reports each rule on a synthetic graph", () => {
    const graph = new Map<string, string[]>([
      ["kind.ts", ["@nikovirtala/ledger", "kind/schemas.ts", "log.ts"]],
      ["kind/rules.ts", ["@nikovirtala/adr/kind", "kind/reduce.ts"]],
      ["kind/graph.ts", ["@nikovirtala/ledger/cli"]],
      ["log.ts", ["cli/text.ts", "@nikovirtala/adr", "@nikovirtala/adr/kind"]],
      ["views.ts", ["@nikovirtala/ledger/testing", "test-support/events.ts"]],
      ["cli/list.ts", ["@nikovirtala/ledger/cli", "log.ts"]],
      ["cli.ts", ["cli/commands.ts"]],
      ["test-support/cli.ts", ["@nikovirtala/ledger/testing", "@nikovirtala/adr", "kind.ts"]],
      ["e2e.test.ts", ["test-support/events.ts", "@nikovirtala/adr"]],
      ["write.ts", ["@nikovirtala/ledger/mcp", "@modelcontextprotocol/sdk/types.js"]],
      ["cli/show.ts", ["mcp/server.ts"]],
      ["cli/mcp.ts", ["mcp/server.ts", "@nikovirtala/ledger/cli"]],
      ["mcp/server.ts", ["@nikovirtala/ledger/mcp", "mcp/tools.ts", "cli/text.ts"]],
      ["mcp/read-tools.test.ts", ["@modelcontextprotocol/sdk/client/index.js", "mcp/server.ts"]],
    ]);
    expect(violations(graph)).toEqual([
      "kind.ts: the kind may import only @nikovirtala/ledger and kind/, not log.ts",
      "kind/rules.ts: the kind may import only @nikovirtala/ledger and kind/, not @nikovirtala/adr/kind",
      "kind/graph.ts: the kind may import only @nikovirtala/ledger and kind/, not @nikovirtala/ledger/cli",
      "kind/graph.ts: only cli.ts and cli/ may import @nikovirtala/ledger/cli",
      "log.ts: only cli.ts and cli/ may import cli/text.ts",
      "log.ts: the library may import adr only as @nikovirtala/adr/kind, not @nikovirtala/adr",
      "views.ts: only tests and test-support/ may import @nikovirtala/ledger/testing",
      "views.ts: only tests and test-support/ may import test-support/events.ts",
      "write.ts: only mcp/ may import @nikovirtala/ledger/mcp",
      "write.ts: only mcp/ may import @modelcontextprotocol/sdk/types.js",
      "cli/show.ts: only cli/mcp.ts may import mcp/server.ts",
      "mcp/server.ts: only cli.ts and cli/ may import cli/text.ts",
    ]);
  });
});
