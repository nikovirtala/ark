/**
 * End to end, session W7: the BUILT `issues mcp`, spawned over real stdio and driven by the MCP
 * SDK's client, in a temp git repository set up with the CLI (design §6.9, §7.7). The helpers are
 * in `test-support/mcp-stdio.ts`. Design §7.3's Table B over stdio, one test per row group of
 * `TABLE_B` (`test-support/write-cells.ts`).
 */
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterAll, describe, expect, it } from "vitest";
import { ME, type WriteIssues, writeRepo } from "./test-support/mcp.js";
import { CONFIG, call, setPolicy, startMcp } from "./test-support/mcp-stdio.js";
import { type RowRepo, runTableB, TABLE_B } from "./test-support/write-cells.js";

describe("issues mcp writes over stdio (built)", () => {
  const repos: TempRepo[] = [];
  afterAll(async () => {
    for (const r of repos.splice(0)) await r.dispose();
  });
  async function setup(
    files: Record<string, string> = {},
  ): Promise<{ r: TempRepo; ids: WriteIssues }> {
    const s = await writeRepo(files);
    repos.push(s.r);
    return s;
  }

  const tableB = (repo: RowRepo, files: Record<string, string> = {}) =>
    it(`session W7: Table B over stdio, the ${repo} rows`, async () => {
      const { r, ids } = await setup(files);
      const s = await startMcp(r, { ARK_ON_BEHALF_OF: ME });
      const rows = TABLE_B.filter((x) => x.repo === repo);
      const n = await runTableB((name, args) => call(s, name, args), ids, rows, {
        setPolicy: (toml) => setPolicy(r, toml),
      });
      expect(n).toBeGreaterThanOrEqual(rows.length * 6);
      expect(await s.close()).toBe(0);
    }, 300_000);
  tableB("start");
  tableB("stop");
  tableB("close");
  tableB("shared");
  tableB("crh", { [CONFIG]: "[policy]\nclose_requires_human = true\n" });
});
