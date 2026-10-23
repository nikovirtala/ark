import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { requireBuilt } from "./test-support/cli.js";

const built = (rel: string) =>
  realpathSync(requireBuilt(fileURLToPath(new URL(rel, import.meta.url))));
const KIND = built("../dist/kind.js");
const ADR_CLI = built("../dist/cli.js");
const LEDGER_CLI = built("../../ledger/dist/cli.js");
const LEDGER_INDEX = built("../../ledger/dist/index.js");

// A resolve hook records every module the import resolves, then prints them.
const CHILD = `
import { registerHooks } from "node:module";
const urls = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const r = nextResolve(specifier, context);
    urls.push(r.url);
    return r;
  },
});
await import(process.env.KIND_URL);
process.stdout.write(JSON.stringify(urls));
`;

// AC 14: importing @nikovirtala/adr/kind never loads CLI code (00:222).
it("imports the kind entry without loading adr's or ledger's cli", () => {
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", CHILD], {
    encoding: "utf8",
    env: { ...process.env, KIND_URL: pathToFileURL(KIND).href },
  });
  expect(out.status, out.stderr).toBe(0);
  const files = (JSON.parse(out.stdout) as string[])
    .filter((u) => u.startsWith("file:"))
    .map((u) => realpathSync(fileURLToPath(u)));
  expect(files).toContain(KIND);
  expect(files).toContain(LEDGER_INDEX);
  expect(files).not.toContain(ADR_CLI);
  expect(files).not.toContain(LEDGER_CLI);
  const cliImport =
    /\bfrom\s*["'](?:\.\/cli\.js|@nikovirtala\/ledger\/cli)["']|import\(\s*["'][^"']*cli\.js["']/;
  for (const file of new Set(files)) {
    expect(readFileSync(file, "utf8"), file).not.toMatch(cliImport);
  }
});
