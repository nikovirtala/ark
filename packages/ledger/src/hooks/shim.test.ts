import { execFile } from "node:child_process";
import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { HookShimError, InvalidArgumentError } from "../errors.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import {
  DEFAULT_HOOK_COMMANDS,
  type HookRegistration,
  normalizeRegistrations,
  parseShim,
  renderShim,
} from "./shim.js";

const run = promisify(execFile);

// Design §4.8, byte for byte.
const GOLDEN = `#!/bin/sh
# ark-hooks v1 (@nikovirtala/ledger). Generated; do not edit.
# Change with \`<tool> hooks install\` or \`<tool> hooks uninstall\`.
# ark-register: {"tool":"adr","argv":["verify","--staged"]}
# ark-register: {"tool":"issues","argv":["verify","--staged"]}
top=$(git rev-parse --show-toplevel) || exit 1
ark_run() {
  tool=$1; shift
  if [ -x "$top/node_modules/.bin/$tool" ]; then "$top/node_modules/.bin/$tool" "$@"
  elif command -v "$tool" >/dev/null 2>&1; then "$tool" "$@"
  else echo "ark hooks: '$tool' is registered for pre-commit but not installed; install it or run '$tool hooks uninstall'" >&2; return 1
  fi
}
status=0
ark_run 'adr' 'verify' '--staged' </dev/null || status=1
ark_run 'issues' 'verify' '--staged' </dev/null || status=1
exit $status
`;

const reg = (tool: string, argv: string[] = ["verify", "--staged"]): HookRegistration => ({
  tool,
  hook: "pre-commit",
  argv,
});

/** The temp repo's hermetic environment, for running a shim by hand. */
function envOf(r: TempRepo): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...r.git.options.env })) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});

describe("DEFAULT_HOOK_COMMANDS", () => {
  it("verifies staged changes before a commit and the pushed commits before a push", () => {
    expect(DEFAULT_HOOK_COMMANDS).toEqual({
      "pre-commit": ["verify", "--staged"],
      "pre-push": ["verify", "--base", "@{upstream}", "--ref", "HEAD", "--fetch-sources"],
    });
    expect(Object.isFrozen(DEFAULT_HOOK_COMMANDS["pre-push"])).toBe(true);
  });
});

describe("renderShim", () => {
  it("renders the design's shim, sorted by tool", () => {
    expect(renderShim("pre-commit", [reg("issues"), reg("adr")])).toBe(GOLDEN);
  });

  it("deduplicates by tool, the later registration winning", () => {
    const text = renderShim("pre-commit", [reg("adr", ["old"]), reg("adr")]);
    expect(parseShim(text)).toEqual([reg("adr")]);
  });

  it("names its hook in the not-installed message and expands {args}", () => {
    const text = renderShim("commit-msg", [
      { tool: "issues", hook: "commit-msg", argv: ["msg", "{args}"] },
    ]);
    expect(text).toContain("is registered for commit-msg but not installed");
    expect(text).toContain(`ark_run 'issues' 'msg' "$@" </dev/null || status=1`);
  });

  it.each<[string, HookRegistration]>([
    ["a bad tool name", reg("Adr")],
    ["an empty token", reg("adr", [""])],
    ["a newline", reg("adr", ["a\nb"])],
    ["a NUL", reg("adr", ["a\0b"])],
    ["another hook", { tool: "adr", hook: "pre-push", argv: [] }],
  ])("rejects %s", (_, r) => {
    expect(() => renderShim("pre-commit", [r])).toThrow(InvalidArgumentError);
  });

  it("passes argv to the tool exactly, with the hook's arguments for {args}", async () => {
    const r = await createTempRepo();
    repos.push(r);
    const tool = join(r.root, "node_modules/.bin/echo-args");
    await r.write("node_modules/.bin/echo-args", `#!/bin/sh\nprintf '%s\\n' "$@" > out\n`);
    await chmod(tool, 0o755);
    const argv = ["it's", "a b", "$HOME", '"q"', "`x`", "{args}", "\\"];
    await r.write(
      "hook",
      renderShim("commit-msg", [{ tool: "echo-args", hook: "commit-msg", argv }]),
    );
    await run("sh", ["hook", "msg file", "*"], { cwd: r.root, env: envOf(r) });
    const out = await readFile(join(r.root, "out"), "utf8");
    expect(out).toBe(
      `${["it's", "a b", "$HOME", '"q"', "`x`", "msg file", "*", "\\"].join("\n")}\n`,
    );
  });

  it("fails, still running every tool, when one fails or is missing", async () => {
    const r = await createTempRepo();
    repos.push(r);
    for (const [name, code] of [
      ["one", 1],
      ["two", 0],
    ] as const) {
      await r.write(`node_modules/.bin/${name}`, `#!/bin/sh\necho ${name} >> ran\nexit ${code}\n`);
      await chmod(join(r.root, `node_modules/.bin/${name}`), 0o755);
    }
    await r.write("hook", renderShim("pre-commit", [reg("one"), reg("two"), reg("zz-missing")]));
    const e = await run("sh", ["hook"], { cwd: r.root, env: envOf(r) }).catch(
      (x: { code: number; stderr: string }) => x,
    );
    expect(e).toMatchObject({ code: 1 });
    expect((e as { stderr: string }).stderr).toContain(
      "ark hooks: 'zz-missing' is registered for pre-commit but not installed",
    );
    expect(await readFile(join(r.root, "ran"), "utf8")).toBe("one\ntwo\n");
  });
});

describe("parseShim", () => {
  it("returns null for a file that isn't an ark shim", () => {
    expect(parseShim("#!/bin/sh\nexec lint-staged\n")).toBeNull();
    expect(parseShim("")).toBeNull();
  });

  it.each([
    ["a malformed register line", GOLDEN.replace('{"tool":"adr"', '{"tool":adr')],
    [
      "a register line of the wrong shape",
      GOLDEN.replace('"argv":["verify","--staged"]', '"argv":"verify"'),
    ],
    ["an invalid tool", GOLDEN.replace('"tool":"adr"', '"tool":"A D R"')],
    ["no hook name", GOLDEN.replace("registered for pre-commit", "registered for")],
  ])("throws HookShimError for %s", (_, text) => {
    expect(() => parseShim(text, { path: "/repo/.git/hooks/pre-commit" })).toThrow(HookShimError);
  });

  it("round-trips the sorted, deduplicated registrations", () => {
    const token = fc.oneof(
      fc.constantFrom("'", '"', " ", "$", "$@", "{args}", "\\", "`", "a b", "it's"),
      fc.string({ minLength: 1 }).filter((s) => !/[\0\r\n]/.test(s)),
    );
    const arbReg = fc.record({
      tool: fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/),
      hook: fc.constant("pre-push" as const),
      argv: fc.array(token, { maxLength: 5 }),
    });
    fc.assert(
      fc.property(fc.array(arbReg, { maxLength: 6 }), (regs) => {
        expect(parseShim(renderShim("pre-push", regs))).toEqual(normalizeRegistrations(regs));
      }),
    );
  });
});
