/**
 * Design §7.3's Table B over the in-memory client, one test per row group of `TABLE_B`
 * (`test-support/write-cells.ts`); `write-tools.test.ts` tests each write tool, and
 * `mcp-e2e.table-b.test.ts` runs the same table over stdio.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { connectMcp, type WriteIssues, writeRepo } from "../test-support/mcp.js";
import { type RowRepo, runTableB, TABLE_B } from "../test-support/write-cells.js";

const repos: TempRepo[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closes.splice(0)) await c();
  for (const r of repos.splice(0)) await r.dispose();
});

async function setup(
  files: Record<string, string> = {},
): Promise<{ r: TempRepo; ids: WriteIssues }> {
  const s = await writeRepo(files);
  repos.push(s.r);
  return s;
}
async function connect(r: TempRepo, env?: NodeJS.ProcessEnv) {
  const c = await connectMcp(r, env);
  closes.push(c.close);
  return c;
}

describe("issues mcp write tools", { timeout: 120_000 }, () => {
  const tableB = (repo: RowRepo, files: Record<string, string> = {}) =>
    it(`Table B: the ${repo} rows`, async () => {
      const { r, ids } = await setup(files);
      const { client } = await connect(r);
      const rows = TABLE_B.filter((x) => x.repo === repo);
      const n = await runTableB(
        (name, args) => client.callTool({ name, arguments: args }),
        ids,
        rows,
        {
          setPolicy: (toml) => writeFile(join(r.root, "docs/issues/issues.toml"), toml),
        },
      );
      expect(n).toBeGreaterThanOrEqual(rows.length * 6);
    });
  tableB("start");
  tableB("stop");
  tableB("close");
  tableB("shared");
  tableB("crh", { "docs/issues/issues.toml": "[policy]\nclose_requires_human = true\n" });
});
