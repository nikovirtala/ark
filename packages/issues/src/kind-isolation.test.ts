import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { requireBuilt } from "./test-support/cli.js";

const built = (rel: string) =>
  realpathSync(requireBuilt(fileURLToPath(new URL(rel, import.meta.url))));
const KIND = built("../dist/kind.js");
const ISSUES_INDEX = built("../dist/index.js");
const ISSUES_CLI = built("../dist/cli.js");
const LEDGER_CLI = built("../../ledger/dist/cli.js");
const LEDGER_INDEX = built("../../ledger/dist/index.js");
const LEDGER_MCP = built("../../ledger/dist/mcp.js");
const ADR_DIR = `${dirname(built("../../adr/package.json"))}${sep}`;

// A resolve hook that records every module resolved and prints the list to stderr on exit,
// loaded with --import before an entry is imported or a script runs (adr's kind-isolation test).
const RECORDER = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from "node:module";
const urls = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const r = nextResolve(specifier, context);
    urls.push(r.url);
    return r;
  },
});
process.on("exit", () => process.stderr.write("\\nRESOLVED " + JSON.stringify(urls) + "\\n"));
`)}`;

/** The files resolved by `node <args>` (or by importing `url`), and every URL, in a fresh process. */
function resolvedBy(o: { readonly url?: string; readonly args?: readonly string[] }): {
  files: string[];
  urls: string[];
} {
  const args = o.args ?? ["--input-type=module", "-e", `await import(${JSON.stringify(o.url)});`];
  const out = spawnSync(process.execPath, ["--import", RECORDER, ...args], { encoding: "utf8" });
  expect(out.status, out.stderr).toBe(0);
  const urls = JSON.parse(out.stderr.split("\nRESOLVED ").at(-1) ?? "[]") as string[];
  const files = urls
    .filter((u) => u.startsWith("file:"))
    .map((u) => realpathSync(fileURLToPath(u)));
  return { files, urls };
}

/** Neither ledger's mcp entry nor the MCP SDK was resolved. */
function expectNoMcp(r: { files: string[]; urls: string[] }): void {
  expect(r.files).not.toContain(LEDGER_MCP);
  expect(r.urls.filter((u) => u.includes("/@modelcontextprotocol/"))).toEqual([]);
}

// ADR-0006: importing @nikovirtala/issues/kind loads no CLI or MCP code, and no adr code at all.
it("imports the kind entry without loading CLI code, adr or MCP code", () => {
  const r = resolvedBy({ url: pathToFileURL(KIND).href });
  expect(r.files).toContain(KIND);
  expect(r.files).toContain(LEDGER_INDEX);
  expect(r.files).not.toContain(ISSUES_CLI);
  expect(r.files).not.toContain(LEDGER_CLI);
  expect(r.files.filter((f) => f.startsWith(ADR_DIR))).toEqual([]);
  const cliImport =
    /\bfrom\s*["'](?:\.\/cli\.js|@nikovirtala\/ledger\/cli)["']|import\(\s*["'][^"']*cli\.js["']/;
  for (const file of new Set(r.files)) {
    expect(readFileSync(file, "utf8"), file).not.toMatch(cliImport);
  }
  expectNoMcp(r);
});

it("imports the library entry without loading MCP code", () => {
  const r = resolvedBy({ url: pathToFileURL(ISSUES_INDEX).href });
  expect(r.files).toContain(ISSUES_INDEX);
  expectNoMcp(r);
});

it("runs issues --version without loading MCP code", () => {
  const r = resolvedBy({ args: [ISSUES_CLI, "--version"] });
  expect(r.files).toContain(ISSUES_CLI);
  expectNoMcp(r);
});
