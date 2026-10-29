import { execFileSync } from "node:child_process";
import { appendFile, chmod, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { openDecisionLog } from "./log.js";
import { cliRepo, REPO_HUMAN, runAdr, seedDecision } from "./test-support/cli.js";
import { INDEX_CONFIG } from "./test-support/index-repo.js";
import { acceptDecision, applyPlan, type WriteResultJson } from "./write.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});

const GLOBS = ["docs/it's.md", "src/orders/**", "src/payments/**"];
// After the seeding clock: an event never gets a time before the log's latest event
// (`nextEventIdentity`), so an earlier fixed time would give the seeding repo's latest time.
const FIXED_MS = Date.parse("2099-01-01T00:00:00Z");
const MARKER = "copy-scope callback";

/** ADR-0001 scoped to `GLOBS`, and a committed proposal that supersedes it; their ids. */
async function supersedingRepo(): Promise<{ r: TempRepo; old: string; next: string }> {
  const r = await cliRepo({
    "docs/adr/adr.toml": INDEX_CONFIG,
    "docs/it's.md": "x\n",
    "src/orders/api.ts": "export {}\n",
    "src/payments/pay.ts": "x\n",
  });
  repos.push(r);
  const old = await seedDecision(r, "Use DynamoDB for orders");
  const set = GLOBS.flatMap((g) => ["--set", g]);
  expect(runAdr(r, ["scope", old, ...set, "--commit"]).status).toBe(0);
  const next = await seedDecision(r, "Use Aurora for orders", { accept: false, supersedes: [old] });
  return { r, old, next };
}

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** A git wrapper next to the repo that appends each spawn's arguments to a log; its paths. */
async function spawnLog(r: TempRepo): Promise<{ binary: string; log: string }> {
  const dir = dirname(r.root);
  const log = join(dir, "spawns.log");
  const binary = join(dir, "git-counting");
  const git = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  await writeFile(log, "");
  await writeFile(
    binary,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(log)}\nexec ${quote(git)} "$@"\n`,
  );
  await chmod(binary, 0o755);
  return { binary, log };
}

/** Fields set from the seeding clock (`seedDecision` and `adr scope` run on real time). */
const SEEDING_TIMES = new Set(["proposed_at", "decided_at", "history"]);

/** A result with this repository's ids replaced by roles and seeding-clock fields dropped. */
function shape(d: WriteResultJson, ids: { old: string; next: string }): unknown {
  return JSON.parse(
    JSON.stringify(
      {
        ok: d.ok,
        decision: d.decision,
        affected: d.affected,
        findings: d.findings,
        notes: d.notes,
      },
      (k, v) =>
        SEEDING_TIMES.has(k)
          ? undefined
          : typeof v === "string"
            ? v.replaceAll(ids.old, "OLD").replaceAll(ids.next, "NEXT")
            : v,
    ),
  );
}

// The copyScope callback may prompt a person or run other processes, so acceptDecision ends the
// git operation's generation after it (D2 rule 3 of the ?24 design).
describe("acceptDecision's copyScope callback in a git operation", { timeout: 120_000 }, () => {
  it("drops cached answers after the callback and writes what copyScope: copy writes", async () => {
    const deps = { now: () => FIXED_MS, apply: applyPlan };

    const a = await supersedingRepo();
    const spawns = await spawnLog(a.r);
    const logA = await openDecisionLog({
      cwd: a.r.root,
      gitOptions: { env: a.r.env, binary: spawns.binary },
    });
    const withCallback = await acceptDecision(
      logA,
      { id: a.next, actor: REPO_HUMAN },
      {
        commit: true,
        copyScope: async () => {
          await appendFile(spawns.log, `${MARKER}\n`);
          return true;
        },
      },
      deps,
    );
    const lines = (await readFile(spawns.log, "utf8")).split("\n");
    const marker = lines.indexOf(MARKER);
    expect(marker).toBeGreaterThan(0);
    const after = lines.slice(marker + 1);
    const firstAdd = after.findIndex((l) => / add( |$)/.test(l));
    expect(firstAdd).toBeGreaterThan(0);
    expect(
      after.slice(0, firstAdd).some((l) => l.endsWith("rev-parse --is-shallow-repository")),
    ).toBe(true);

    const b = await supersedingRepo();
    const logB = await openDecisionLog({ cwd: b.r.root, gitOptions: { env: b.r.env } });
    const withCopy = await acceptDecision(
      logB,
      { id: b.next, actor: REPO_HUMAN },
      { commit: true, copyScope: "copy" },
      deps,
    );

    expect(withCallback.ok).toBe(true);
    expect(withCallback.decision?.applies_to).toEqual(GLOBS);
    expect(shape(withCallback, a)).toEqual(shape(withCopy, b));
  });
});
