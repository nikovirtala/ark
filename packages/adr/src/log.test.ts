import {
  ConfigError,
  foldLog,
  loadLog,
  MemoryTree,
  NO_NUMBERING,
  projectLog,
  RefNotFoundError,
} from "@nikovirtala/ledger";
import { createTempRepo, type TempRepo } from "@nikovirtala/ledger/testing";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ADR_CONFIG } from "./config.js";
import { adrKind, type DecisionView } from "./kind.js";
import { openDecisionLog, readDecisions, readDecisionsFrom } from "./log.js";
import { arbAdrHistory } from "./test-support/decision-arbs.js";
import {
  COMPILED,
  decisionEvent,
  decisionFiles,
  eventFile,
  hashOf,
  LAYOUT,
  proposedData,
} from "./test-support/events.js";
import { listDecisions } from "./views.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});

async function repo(files?: Record<string, string>): Promise<TempRepo> {
  const r = await createTempRepo(files === undefined ? {} : { files });
  repos.push(r);
  return r;
}

const open = (r: TempRepo, o: { ref?: string; root?: string } = {}) =>
  openDecisionLog({ cwd: r.root, gitOptions: { env: r.env }, ...o });

/** The git-backed properties spawn a few hundred git processes; allow for a loaded machine. */
const GIT_PROPERTY_TIMEOUT = 120_000;

const A = "a7c2m9xd";
const B = "k3f9q8a1";
const BODY = "# Decision\n";

describe("openDecisionLog", () => {
  it("opens docs/adr with the default config", async () => {
    const r = await repo({ "README.md": "x\n" });
    const log = await open(r);
    expect(log.layout.root).toBe("docs/adr");
    expect(log.adr).toEqual(DEFAULT_ADR_CONFIG);
    expect(log.configPath).toBeNull();
  });

  it("reads adr's settings from the config file that chose the root", async () => {
    const r = await repo({
      "adr.toml": '[log]\nroot = "decisions"\n[policy]\nauto_commit = true\n',
    });
    const log = await open(r);
    expect(log.layout.root).toBe("decisions");
    expect(log.configPath).toBe("adr.toml");
    expect(log.adr.autoCommit).toBe(true);
  });

  it("refuses an invalid adr setting", async () => {
    const r = await repo({ "docs/adr/adr.toml": "[verify]\nfail_on = 'never'\n" });
    await expect(open(r)).rejects.toThrow(ConfigError);
    await expect(open(r)).rejects.toThrow(/^docs\/adr\/adr\.toml: verify\.fail_on/);
  });
});

describe("readDecisions", () => {
  it("numbers decisions in the order their acceptance landed on main", async () => {
    const r = await repo();
    const pa = decisionEvent(A, "proposed", { data: proposedData("A") });
    const pb = decisionEvent(B, "proposed", { data: proposedData("B") });
    await r.writeFiles(
      decisionFiles([
        { id: A, body: BODY, events: [pa] },
        { id: B, body: BODY, events: [pb] },
      ]),
    );
    await r.stage("docs");
    await r.commit("propose");
    const accept = async (id: string) => {
      const [path, content] = eventFile(
        decisionEvent(id, "accepted", { data: { body_sha256: hashOf(BODY) } }),
      );
      await r.write(path, content);
      await r.stage(path);
      return r.commit(`accept ${id}`);
    };
    await accept(B);
    let list = listDecisions(await readDecisions(await open(r)));
    expect(list.numbering).toEqual({ available: true, reason: null, ref: "refs/heads/main" });
    expect(list.decisions.map((d) => [d.display, d.id])).toEqual([
      ["ADR-0001", B],
      [A, A],
    ]);
    const second = await accept(A);
    list = listDecisions(await readDecisions(await open(r)));
    expect(list.commit).toBe(second);
    expect(list.decisions.map((d) => [d.display, d.id])).toEqual([
      ["ADR-0001", B],
      ["ADR-0002", A],
    ]);
  });

  it("uses the configured main branch, which must exist", async () => {
    const r = await repo({ "adr.toml": '[log]\nmain_branch = "refs/heads/trunk"\n' });
    await expect(readDecisions(await open(r))).rejects.toThrow(RefNotFoundError);
  });

  it("reports numbers as unavailable without a main ref", async () => {
    const r = await createTempRepo({ initialBranch: "work", files: { "x.md": "x\n" } });
    repos.push(r);
    const read = await readDecisions(await open(r));
    expect(read.numbering).toBe(NO_NUMBERING);
  });
});

const strip = ({ number: _n, display: _d, ...rest }: DecisionView) => rest;
const byId = (vs: readonly DecisionView[]) =>
  [...vs].sort((a, b) => (a.id < b.id ? -1 : 1)).map(strip);

describe("time travel (AC 10)", () => {
  it(
    "lists each commit like the projection of a MemoryTree of the files at that commit",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbAdrHistory(), fc.gen(), async (h, g) => {
          const r = await repo();
          const bodyOf = new Map(h.subjects.map((s) => [s.id, s.bodyPath]));
          const files: Record<string, string> = {};
          const commits: { sha: string; files: Record<string, string> }[] = [];
          let i = 0;
          while (i < h.steps.length) {
            const n = g(fc.integer, { min: 1, max: Math.max(1, h.steps.length - i) });
            const chunk: Record<string, string> = {};
            for (const { subject, path, event } of h.steps.slice(i, i + n)) {
              const body = bodyOf.get(subject) ?? null;
              if (event.type === "proposed" && body !== null) chunk[body] = h.files[body] ?? "";
              chunk[path] = h.files[path] ?? "";
            }
            i += n;
            await r.writeFiles(chunk);
            await r.stage(...Object.keys(chunk));
            Object.assign(files, chunk);
            commits.push({ sha: await r.commit(`steps to ${i}`), files: { ...files } });
          }
          for (const c of commits) {
            const list = listDecisions(await readDecisions(await open(r, { ref: c.sha })));
            const tree = new MemoryTree(c.files);
            const folded = foldLog(
              adrKind,
              await loadLog(tree, { kind: COMPILED, layout: LAYOUT }),
            );
            const projection = projectLog(adrKind, folded, { numbering: NO_NUMBERING });
            const memory = listDecisions(
              await readDecisionsFrom(tree, {
                layout: LAYOUT,
                adr: DEFAULT_ADR_CONFIG,
                numbering: NO_NUMBERING,
              }),
            );
            expect(list.commit).toBe(c.sha);
            expect(byId(list.decisions)).toEqual(byId([...projection.views.values()]));
            expect(list.unreadable).toEqual(projection.unreadable);
            expect(list.unfoldable).toEqual(projection.unfoldable);
            expect(list.findings).toEqual(memory.findings);
          }
        }),
        { numRuns: 10 },
      );
    },
    GIT_PROPERTY_TIMEOUT,
  );
});
