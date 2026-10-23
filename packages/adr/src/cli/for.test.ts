import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { cliRepo, runAdr, seedDecision, seedSupersession } from "../test-support/cli.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function git(r: TempRepo, ...args: string[]): Promise<string> {
  return Buffer.from((await r.git.run(args)).stdout).toString("utf8");
}

/** A comment anchor, built at run time so this file holds no literal one (design §3.3). */
const anchor = (...parts: string[]) => ["adr", ...parts].join(":");
const FOR_KEYS = ["commit", "findings", "format", "notes", "numbering", "paths", "ref", "root"];

type ForDoc = {
  format: string;
  ref: string | null;
  paths: {
    path: string;
    tracked: boolean;
    decisions: {
      id: string;
      display: string;
      status: string;
      warning: string | null;
      via: ({ type: "glob"; glob: string } | { type: "anchor"; line: number })[];
    }[];
    unresolved: { ref: string; line: number; reason: string }[];
  }[];
};
function doc(stdout: string): ForDoc {
  const d = JSON.parse(stdout) as ForDoc;
  expect(d.format).toBe("adr-for/v1");
  expect(Object.keys(d).sort()).toEqual(FOR_KEYS);
  return d;
}

/**
 * ADR-0001 "Use DynamoDB for orders" (`src/**`) superseded by ADR-0002 "Use Aurora for orders"
 * (`src/orders/**`); a proposal anchored in `src/orders/api.ts`; a rejected decision with `src/**`.
 */
async function forRepo(files: Record<string, string> = {}) {
  const r = await cliRepo({
    "src/orders/api.ts": "export {}\n",
    "src/util/time.ts": "export {}\n",
    ...files,
  });
  repos.push(r);
  const old = await seedDecision(r, "Use DynamoDB for orders");
  expect(runAdr(r, ["scope", old, "--set", "src/**", "--commit"]).status).toBe(0);
  const aurora = await seedDecision(r, "Use Aurora for orders");
  expect(runAdr(r, ["scope", aurora, "--set", "src/orders/**", "--commit"]).status).toBe(0);
  await seedSupersession(r, old, aurora);
  const cache = await seedDecision(r, "Cache order reads", { accept: false });
  const rejected = await seedDecision(r, "Use files", { accept: false });
  expect(runAdr(r, ["scope", rejected, "--set", "src/**", "--commit"]).status).toBe(0);
  expect(runAdr(r, ["reject", rejected, "--reason", "No", "--commit"]).status).toBe(0);
  await r.write(
    "src/orders/api.ts",
    [
      `// ${anchor("platform", "k3f9q8a1")}`,
      "export {}",
      `// ${anchor(cache)} keep the cache in sync`,
      `// ${anchor("a7c2m9xd")}`,
      "",
    ].join("\n"),
  );
  await r.stage("src/orders/api.ts");
  await r.commit("feat: anchor the cache decision");
  return { r, old, aurora, cache, rejected };
}

// 01:146–148, 01:222, 01:252, design §6.9 and its §16.4 row.
describe("adr for", { timeout: 120_000 }, () => {
  it("lists decisions by glob and anchor, accepted first, with warnings and unresolved anchors", async () => {
    const { r, old, aurora, cache } = await forRepo();
    const out = runAdr(r, ["for", "src/orders/api.ts", "src/util/time.ts"]);
    expect(out.status).toBe(0);
    expect(out.stderr).toBe("");
    const lines = out.stdout.split("\n");
    expect(lines[0]).toBe("src/orders/api.ts");
    expect(lines.slice(1, 4).map((l) => l.replace(/ +/g, " "))).toEqual([
      ` ADR-0002 (${aurora}) accepted Use Aurora for orders glob src/orders/**`,
      ` ${cache} proposed Cache order reads anchor line 3`,
      ` ADR-0001 (${old}) superseded Use DynamoDB for orders glob src/**`,
    ]);
    expect(lines[4]).toMatch(
      /^ {4}SUPERSEDED by ADR-0002 \(accepted \d{4}-\d\d-\d\d\)\. Do not apply this decision; read ADR-0002 instead\.$/,
    );
    expect(lines.slice(5)).toEqual([
      `  unresolved: ${anchor("platform", "k3f9q8a1")} (line 1, in another log)`,
      `  unresolved: ${anchor("a7c2m9xd")} (line 4, not in this log)`,
      "src/util/time.ts",
      `  ADR-0001 (${old})  superseded  Use DynamoDB for orders  glob src/**`,
      lines[9] ?? "",
      "",
    ]);
    expect(lines[9]).toMatch(/^ {4}SUPERSEDED by ADR-0002/);

    const d = doc(runAdr(r, ["--json", "for", "src/orders/api.ts"]).stdout);
    expect(d.ref).toBeNull();
    expect(d.paths).toHaveLength(1);
    expect(d.paths[0]).toMatchObject({ path: "src/orders/api.ts", tracked: true });
    expect(d.paths[0]?.decisions.map((x) => [x.id, x.status, x.via])).toEqual([
      [aurora, "accepted", [{ type: "glob", glob: "src/orders/**" }]],
      [cache, "proposed", [{ type: "anchor", line: 3 }]],
      [old, "superseded", [{ type: "glob", glob: "src/**" }]],
    ]);
    expect(d.paths[0]?.decisions.map((x) => x.warning === null)).toEqual([true, true, false]);
    expect(d.paths[0]?.unresolved).toEqual([
      { ref: "platform:k3f9q8a1", line: 1, reason: "other-log" },
      { ref: "a7c2m9xd", line: 4, reason: "not-found" },
    ]);
  });

  it("keeps anchors of a rejected decision, finds both vias, and allows untracked paths", async () => {
    const { r, old, aurora, rejected } = await forRepo();
    await r.write("src/orders/new.ts", `// ${anchor(rejected)}\n// ${anchor(aurora)}\n`);
    const d = doc(runAdr(r, ["--json", "for", "src/orders/new.ts", "src/none.ts"]).stdout);
    expect(d.paths.map((p) => [p.path, p.tracked])).toEqual([
      ["src/orders/new.ts", false],
      ["src/none.ts", false],
    ]);
    expect(d.paths[0]?.decisions.map((x) => [x.id, x.via])).toEqual([
      [
        aurora,
        [
          { type: "glob", glob: "src/orders/**" },
          { type: "anchor", line: 2 },
        ],
      ],
      [old, [{ type: "glob", glob: "src/**" }]],
      [rejected, [{ type: "anchor", line: 1 }]],
    ]);
    expect(d.paths[1]?.decisions.map((x) => x.id)).toEqual([old]);
    const text = runAdr(r, ["for", "src/none.ts", "README.md"]).stdout;
    expect(text).toMatch(/^src\/none\.ts \(not tracked\)\n/);
    expect(text).toMatch(/\nREADME\.md\n {2}no decisions\n$/);
  });

  it("treats a symlink to a directory and a missing path as file paths", async () => {
    const { r, old, aurora } = await forRepo();
    await symlink(join(r.root, "src/orders"), join(r.root, "src/link"));
    // src/orders/ap is a string prefix of the tracked src/orders/api.ts, not a directory.
    const paths = ["src/link", "src/missing.ts", "src/orders/ap"];
    const out = runAdr(r, ["--json", "for", ...paths]);
    expect(out.status).toBe(0);
    const d = doc(out.stdout);
    expect(d.paths.map((p) => [p.path, p.tracked, p.decisions.map((x) => x.id)])).toEqual([
      ["src/link", false, [old]],
      ["src/missing.ts", false, [old]],
      ["src/orders/ap", false, [aurora, old]],
    ]);
  });

  it("reads the log, the config and the anchors at --ref", async () => {
    const { r, aurora, cache } = await forRepo();
    const head = (await git(r, "rev-parse", "HEAD")).trim();
    await r.write("src/util/time.ts", `// ${anchor(cache)}\n`);
    expect(runAdr(r, ["scope", aurora, "--add", "src/util/**", "--commit"]).status).toBe(0);
    const now = doc(runAdr(r, ["--json", "for", "src/util/time.ts"]).stdout);
    expect(now.paths[0]?.decisions.map((x) => x.id)).toContain(cache);
    expect(now.paths[0]?.decisions.map((x) => x.id)).toContain(aurora);
    const then = doc(runAdr(r, ["--json", "--ref", head, "for", "src/util/time.ts"]).stdout);
    expect(then.ref).toBe(head);
    expect(then.paths[0]?.decisions.map((x) => x.id)).not.toContain(cache);
    expect(then.paths[0]?.decisions.map((x) => x.id)).not.toContain(aurora);
  });

  it("follows a git mv once --follow-renames has staged the new globs", async () => {
    const { r, aurora, cache } = await forRepo();
    await git(r, "mv", "src/orders", "src/billing");
    expect(runAdr(r, ["scope", "--follow-renames"]).status).toBe(0);
    const d = doc(runAdr(r, ["--json", "for", "src/billing/api.ts"]).stdout);
    expect(d.paths[0]?.decisions.map((x) => [x.id, x.via[0]])).toEqual([
      [aurora, { type: "glob", glob: "src/billing/**" }],
      [cache, { type: "anchor", line: 3 }],
      [expect.any(String), { type: "glob", glob: "src/**" }],
    ]);
  });

  it("ignores anchors in files that anchor_exclude matches", async () => {
    const r = await cliRepo({
      "docs/adr/adr.toml": '[scope]\nanchor_exclude = ["docs/**"]\n',
      "src/a.ts": "export {}\n",
    });
    repos.push(r);
    const id = await seedDecision(r, "Use Aurora", { accept: false });
    await r.write("docs/guide.md", `<!-- ${anchor(id)} -->\n`);
    await r.write("src/a.ts", `// ${anchor(id)}\n`);
    const d = doc(runAdr(r, ["--json", "for", "docs/guide.md", "src/a.ts"]).stdout);
    expect(d.paths.map((p) => p.decisions.map((x) => x.id))).toEqual([[], [id]]);
  });

  it("exits 2 for a directory, a path outside the repository, an unknown ref and bad config", async () => {
    const r = await cliRepo({ "src/a.ts": "export {}\n" });
    repos.push(r);
    const usage = (args: string[], message: string, code = "usage") => {
      const out = runAdr(r, ["--json", ...args]);
      expect(out.status, args.join(" ")).toBe(2);
      expect(JSON.parse(out.stdout)).toMatchObject({ format: "ark-error/v1", error: { code } });
      expect(out.stderr).toContain(`adr: error: ${message}`);
    };
    usage(
      ["for", "src"],
      "src is a directory; adr for takes file paths, for example adr for $(git ls-files src)",
    );
    usage(["for", "."], ". is a directory");
    // An empty untracked directory lists nothing, so only the up-front check catches it.
    await mkdir(join(r.root, "src/empty"));
    usage(["for", "src/empty"], "src/empty is a directory");
    usage(["--ref", "HEAD", "for", "src"], "src is a directory");
    usage(["for", "../elsewhere.ts"], "../elsewhere.ts is outside the repository");
    usage(["--ref", "nope", "for", "src/a.ts"], "ref not found: nope", "ref-not-found");
    usage(["for"], "missing argument <path>");
    // A directory deleted from the work tree but still in the index is still a directory.
    await rm(join(r.root, "src"), { recursive: true });
    usage(["for", "src"], "src is a directory");
    await writeFile(join(r.root, "adr.toml"), '[scope]\nanchor_exclude = ["/abs"]\n');
    usage(["for", "src/a.ts"], "adr.toml: scope.anchor_exclude[0]: invalid glob", "config");
  });
});
