import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { cliRepo, newIssue, runIssues } from "./test-support/cli.js";

// ark's commit rules, which every default issues subject must pass (?6).
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

const dir = mkdtempSync(join(tmpdir(), "issues-subjects-"));
let n = 0;

function ok(r: TempRepo, args: string[]): string {
  const out = runIssues(r, args);
  expect(out.status, `issues ${args.join(" ")}\n${out.stderr}`).toBe(0);
  return out.stderr;
}

/** HEAD's subject, after checking that the whole message passes ark's commitlint. */
function subject(r: TempRepo): string {
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
  return git("%s").trimEnd();
}

describe("issues' default commit subjects", { timeout: 180_000 }, () => {
  it("names the issue by number and quoted title, and passes ark's commitlint", async () => {
    const r = await repo();
    ok(r, ["init", "--commit"]);
    expect(subject(r)).toBe("docs(issues): set up the issue log");
    const a = newIssue(r, "Split the orders service");
    expect(subject(r)).toBe('docs(issues): open "split the orders service"');
    const b = newIssue(r, "Extract the consumer");
    const s = '?1 "split the orders service"';
    const forms: [string[], string][] = [
      [["start", a, "--commit"], `start work on ${s}`],
      [["stop", a, "--reason", "Waiting.", "--commit"], `stop work on ${s}`],
      [["assign", a, "--add", "ada@example.com", "--commit"], `set the assignees of ${s}`],
      [["label", a, "--add", "type:feature", "--commit"], `set the labels of ${s}`],
      [["scope", a, "--set", "src/**", "--commit"], `set the scope of ${s}`],
      [["comment", a, "Looks right.", "--commit"], `comment on ${s}`],
      [["link", a, b, "--rel", "depends-on", "--commit"], `link ${s} to ?2`],
      [["unlink", a, b, "--commit"], `unlink ${s} from ?2`],
      [["edit", a, "--section", "goal=Two services.", "--commit"], `edit ${s}`],
      [["close", a, "--reason", "Done.", "--commit"], `close ${s}`],
      [["reopen", a, "--reason", "Not done.", "--commit"], `reopen ${s}`],
      [
        ["close", a, "--resolution", "wontfix", "--reason", "No.", "--commit"],
        `close ${s} as won't fix`,
      ],
      [
        ["close", b, "--duplicate-of", a, "--reason", "Same work.", "--commit"],
        '?2 "extract the consumer" as a duplicate of ?1',
      ],
    ];
    for (const [args, want] of forms) {
      ok(r, args);
      expect(subject(r)).toBe(
        want.startsWith("?2") ? `docs(issues): close ${want}` : `docs(issues): ${want}`,
      );
    }

    // Batches: a staged link swept into a scope commit.
    const c = newIssue(r, "Move the schema");
    const d = newIssue(r, "Drop the old table");
    ok(r, ["link", c, d]);
    ok(r, ["scope", c, "--set", "src/a.ts", "--commit"]);
    expect(subject(r)).toBe('docs(issues): link and scope ?3 "move the schema"');
  });

  it("shortens a long title inside the quotes, says so, and passes commitlint", async () => {
    const r = await repo();
    const title =
      "Add the retry budget and the circuit breaker to the payments gateway client library";
    const stderr = runIssues(r, [
      "new",
      title,
      "--section",
      "goal=Do it.",
      "--section",
      "done=Done.",
      "--commit",
    ]).stderr;
    const got = subject(r);
    expect(got).toMatch(/^docs\(issues\): open "add the retry budget .*…"$/);
    expect(got.length - "docs(issues): ".length).toBeLessThanOrEqual(72);
    expect(stderr).toContain(
      'the title was shortened to keep the commit description (after "docs(issues):") within 72 characters; the full title is in the commit body',
    );
  });

  it("keeps quotes, apostrophes and other scripts in the title", async () => {
    const r = await repo();
    for (const [title, want] of [
      ['Use the "fast" path', 'open "use the "fast" path"'],
      ["Don't retry twice", `open "don't retry twice"`],
      ["Käännä virheilmoitukset", 'open "käännä virheilmoitukset"'],
      ["GraphQL schema stitching", 'open "GraphQL schema stitching"'],
    ] as const) {
      newIssue(r, title);
      expect(subject(r)).toBe(`docs(issues): ${want}`);
    }
  });
});
