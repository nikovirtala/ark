import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { cliRepo, runAdr } from "../test-support/cli.js";
import { decisionSource, sourceToml } from "../test-support/sources.js";

const NOTE =
  "numbers are unavailable (platform has no committed index.md); decisions display by id";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});

describe("a cached source without a committed index.md", { timeout: 120_000 }, () => {
  it("lists and searches its decisions by id, with a note naming the missing index", async () => {
    const s = await decisionSource(["Use Aurora for orders"], { index: "none" });
    repos.push(s.src, s.bare);
    const r = await cliRepo({ "docs/adr/adr.toml": sourceToml("platform", s.url) });
    repos.push(r);
    expect(runAdr(r, ["sources", "fetch", "platform"]).status).toBe(0);

    const list = runAdr(r, ["list", "--source", "platform", "--json"]);
    expect(list.status).toBe(0);
    const doc = JSON.parse(list.stdout) as {
      numbering: { available: boolean; reason: string | null };
      decisions: { id: string; display: string }[];
    };
    expect(doc.numbering).toMatchObject({ available: false, reason: "no-index" });
    expect(doc.decisions.map((d) => d.display)).toEqual(s.ids);
    expect(list.stderr).toContain(NOTE);
    expect(list.stderr).not.toContain("no main branch");

    const search = runAdr(r, ["search", "aurora", "--source", "platform"]);
    expect(search.status).toBe(0);
    expect(search.stderr).toContain(NOTE);
    expect(search.stderr).not.toContain("no main branch");
  });
});
