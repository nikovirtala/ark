import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { cliRepo, NYGARD_SECTIONS, runAdr, seedDecision } from "./test-support/cli.js";

// ark's commit rules, which every default adr subject must pass (?6, ADR-0008).
const CONFIG = fileURLToPath(new URL("../../../commitlint.config.mjs", import.meta.url));
const ARK = dirname(CONFIG);
const COMMITLINT = join(ARK, "node_modules", ".bin", "commitlint");

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(): Promise<TempRepo> {
  const r = await cliRepo({ "src/a.ts": "export {};\n" });
  repos.push(r);
  return r;
}

const FULL = Object.entries(NYGARD_SECTIONS).flatMap(([k, v]) => ["--section", `${k}=${v}`]);
const dir = mkdtempSync(join(tmpdir(), "adr-subjects-"));
let n = 0;

function ok(r: TempRepo, args: string[]): string {
  const out = runAdr(r, args);
  expect(out.status, `adr ${args.join(" ")}\n${out.stderr}`).toBe(0);
  return out.stderr;
}

/** HEAD's subject and trailers; the whole message passes ark's commitlint. */
function head(r: TempRepo): { subject: string; trailers: string } {
  const git = (format: string) =>
    spawnSync("git", ["log", "-1", `--format=${format}`], {
      cwd: r.root,
      env: r.env,
      encoding: "utf8",
    }).stdout;
  const message = git("%B");
  const file = join(dir, `msg-${n++}.txt`);
  writeFileSync(file, message);
  const lint = spawnSync(COMMITLINT, ["--config", CONFIG, "--cwd", ARK, "--edit", file], {
    encoding: "utf8",
  });
  expect(lint.status, `${message}\n${lint.stdout}${lint.stderr}`).toBe(0);
  // Pairs in a stable order: staged events of one second sort by their random id part.
  const lines = git("%(trailers:only,unfold)").trimEnd().split("\n");
  const pairs: string[] = [];
  for (let i = 0; i < lines.length; i += 2) pairs.push(`${lines[i]}\n${lines[i + 1]}`);
  return { subject: git("%s").trimEnd(), trailers: pairs.sort().join("\n") };
}

/** `ADR: <id>` / `ADR-Event: <type>` pairs, in `head`'s order. */
const pairsOf = (...xs: [string, string][]) =>
  xs
    .map(([id, type]) => `ADR: ${id}\nADR-Event: ${type}`)
    .sort()
    .join("\n");

describe("adr's default commit subjects", { timeout: 120_000 }, () => {
  it("keeps single-action subjects and names batches of staged events", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Use Aurora for orders");
    const b = await seedDecision(r, "Use Kafka for events");
    const c = await seedDecision(r, "Use Redis for caching");

    ok(r, ["link", a, b, "--commit"]);
    expect(head(r).subject).toBe("docs(adr): link ADR-0001 to ADR-0002");

    // A staged link swept into a scope commit: both verbs, one pair per type.
    ok(r, ["link", a, c]);
    ok(r, ["scope", a, "--set", "src/**", "--commit"]);
    expect(head(r)).toEqual({
      subject: "docs(adr): link and scope ADR-0001",
      trailers: pairsOf([a, "linked"], [a, "scoped"]),
    });

    // Two staged links of one type and a staged scope, swept into a note: three verbs, and the
    // two linked events give one pair.
    ok(r, ["link", b, a]);
    ok(r, ["link", b, c, "--rel", "refines"]);
    ok(r, ["scope", b, "--set", "src/a.ts"]);
    ok(r, ["note", b, "Checked with the team.", "--commit"]);
    expect(head(r)).toEqual({
      subject: "docs(adr): link, scope and add a note to ADR-0002",
      trailers: pairsOf([b, "linked"], [b, "scoped"], [b, "noted"]),
    });

    // More than three verbs: update.
    ok(r, ["link", c, a]);
    ok(r, ["scope", c, "--set", "src/a.ts"]);
    ok(r, ["note", c, "Still in use."]);
    ok(r, ["deprecate", c, "--reason", "Replaced by the platform cache.", "--commit"]);
    expect(head(r).subject).toBe("docs(adr): update ADR-0003");

    // A staged proposal swept into a display-named write: the commit decides to propose it.
    const proposed = JSON.parse(
      runAdr(r, ["new", "Use SQS for jobs", ...FULL, "--no-edit", "--json"]).stdout,
    ) as { decision: { id: string } };
    ok(r, ["scope", proposed.decision.id, "--set", "src/a.ts", "--commit"]);
    expect(head(r)).toEqual({
      subject: "docs(adr): propose to use SQS for jobs",
      trailers: pairsOf([proposed.decision.id, "proposed"], [proposed.decision.id, "scoped"]),
    });

    // Accept keeps its own form.
    const d = await seedDecision(r, "Use Memcached for caching", { accept: false });
    ok(r, ["accept", d, "--commit"]);
    expect(head(r).subject).toBe("docs(adr): decide to use Memcached for caching");
  });

  it("shortens a long title, says so, and still passes commitlint", async () => {
    const r = await repo();
    const title =
      "Add the retry budget and the circuit breaker to the payments gateway client library";
    const stderr = ok(r, ["new", title, ...FULL, "--no-edit", "--commit"]);
    expect(stderr).toContain(
      'adr: warning: the title was shortened to keep the commit description (after "docs(adr):") within 72 characters; the full title is in the commit body\n',
    );
    const { subject } = head(r);
    expect(subject.endsWith("…")).toBe(true);
    expect(subject.length - "docs(adr): ".length).toBeLessThanOrEqual(72);
  });
});
