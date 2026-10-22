import { HookShimError, InvalidArgumentError } from "../errors.js";

export type HookName = "pre-commit" | "commit-msg" | "pre-push" | "post-merge";

/** One tool's command for one hook. The argv token `{args}` expands to the hook's arguments. */
export interface HookRegistration {
  readonly tool: string;
  readonly hook: HookName;
  readonly argv: readonly string[];
}

export const HOOK_NAMES: readonly HookName[] = [
  "pre-commit",
  "commit-msg",
  "pre-push",
  "post-merge",
];

/**
 * What `installHooks` registers by default. There is no `pre-push` default: `verify --base
 * @{upstream}` fails on a branch's first push, and what to do then is the verify surface's call.
 */
export const DEFAULT_HOOK_COMMANDS: Readonly<Partial<Record<HookName, readonly string[]>>> =
  Object.freeze({ "pre-commit": Object.freeze(["verify", "--staged"]) });

export const SHIM_MARKER = "# ark-hooks v1 (@nikovirtala/ledger). Generated; do not edit.";
const REGISTER = "# ark-register: ";
const TOOL = /^[a-z][a-z0-9-]*$/;
const MISSING_TOOL = /is registered for (\S+) but not installed/;

export function isHookName(s: unknown): s is HookName {
  return typeof s === "string" && (HOOK_NAMES as readonly string[]).includes(s);
}

/** Throws `InvalidArgumentError` for a tool name or argv the shim can't carry. */
export function assertRegistration(r: HookRegistration): void {
  if (!TOOL.test(r.tool))
    throw new InvalidArgumentError(`invalid tool name: ${JSON.stringify(r.tool)}`);
  if (!isHookName(r.hook))
    throw new InvalidArgumentError(`invalid hook: ${JSON.stringify(r.hook)}`);
  for (const token of r.argv) {
    if (token === "" || /[\0\r\n]/.test(token)) {
      throw new InvalidArgumentError(
        `invalid argv token for ${r.tool}: ${JSON.stringify(token)}; tokens must be non-empty single lines`,
      );
    }
  }
}

/** Sorted by tool name, one registration per (tool, hook); a later duplicate wins. */
export function normalizeRegistrations(regs: readonly HookRegistration[]): HookRegistration[] {
  const byKey = new Map<string, HookRegistration>();
  for (const r of regs) {
    assertRegistration(r);
    byKey.set(`${r.hook}\0${r.tool}`, { tool: r.tool, hook: r.hook, argv: [...r.argv] });
  }
  return [...byKey.values()].sort((a, b) =>
    a.tool === b.tool
      ? HOOK_NAMES.indexOf(a.hook) - HOOK_NAMES.indexOf(b.hook)
      : a.tool < b.tool
        ? -1
        : 1,
  );
}

function shQuote(token: string): string {
  return token === "{args}" ? '"$@"' : `'${token.replace(/'/g, "'\\''")}'`;
}

/** The complete shim for `hook`: the registry as comment lines, then one call per tool. Pure. */
export function renderShim(hook: HookName, regs: readonly HookRegistration[]): string {
  const sorted = normalizeRegistrations(regs);
  for (const r of sorted) {
    if (r.hook !== hook) {
      throw new InvalidArgumentError(`registration of ${r.tool} is for ${r.hook}, not ${hook}`);
    }
  }
  return [
    "#!/bin/sh",
    SHIM_MARKER,
    "# Change with `<tool> hooks install` or `<tool> hooks uninstall`.",
    ...sorted.map((r) => `${REGISTER}${JSON.stringify({ tool: r.tool, argv: r.argv })}`),
    "top=$(git rev-parse --show-toplevel) || exit 1",
    "ark_run() {",
    "  tool=$1; shift",
    '  if [ -x "$top/node_modules/.bin/$tool" ]; then "$top/node_modules/.bin/$tool" "$@"',
    '  elif command -v "$tool" >/dev/null 2>&1; then "$tool" "$@"',
    `  else echo "ark hooks: '$tool' is registered for ${hook} but not installed; install it or run '$tool hooks uninstall'" >&2; return 1`,
    "  fi",
    "}",
    "status=0",
    ...sorted.map(
      (r) => `ark_run ${[r.tool, ...r.argv].map(shQuote).join(" ")} </dev/null || status=1`,
    ),
    "exit $status",
    "",
  ].join("\n");
}

/**
 * The registrations of an ark shim, or `null` when `text` isn't one (no marker). A shim with the
 * marker that can't be read throws `HookShimError`: a corrupted shim needs a human.
 */
export function parseShim(
  text: string,
  o: { readonly path?: string } = {},
): HookRegistration[] | null {
  const lines = text.split("\n");
  if (!lines.includes(SHIM_MARKER)) return null;
  const path = o.path ?? "";
  const fail = (message: string): never => {
    throw new HookShimError(
      path,
      `unreadable ark hook shim${path === "" ? "" : ` ${path}`}: ${message}`,
    );
  };
  const hook = lines.map((l) => MISSING_TOOL.exec(l)?.[1]).find((h) => h !== undefined);
  if (!isHookName(hook)) return fail("no hook name");
  const regs: HookRegistration[] = [];
  for (const line of lines) {
    if (!line.startsWith(REGISTER)) continue;
    let value: unknown;
    try {
      value = JSON.parse(line.slice(REGISTER.length));
    } catch {
      return fail(`malformed register line ${JSON.stringify(line)}`);
    }
    const v = value as { tool?: unknown; argv?: unknown };
    if (
      typeof value !== "object" ||
      value === null ||
      typeof v.tool !== "string" ||
      !Array.isArray(v.argv) ||
      !v.argv.every((t): t is string => typeof t === "string")
    ) {
      return fail(`malformed register line ${JSON.stringify(line)}`);
    }
    const reg: HookRegistration = { tool: v.tool, hook, argv: v.argv };
    try {
      assertRegistration(reg);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
    regs.push(reg);
  }
  return normalizeRegistrations(regs);
}
