import type { ParseArgsOptionsConfig } from "node:util";

/** The flags every command of every tool takes (00:73). */
export interface GlobalFlags {
  /** Print exactly one JSON document on stdout. */
  readonly json: boolean;
  /** `--root` as given; `null` when absent. */
  readonly root: string | null;
  /** `--ref` as given; `null` when absent. */
  readonly ref: string | null;
}

/** The `parseArgs` options `runCli` adds to every command. */
export const GLOBAL_OPTIONS = {
  json: { type: "boolean" },
  root: { type: "string" },
  ref: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
} as const satisfies ParseArgsOptionsConfig;

/** Short flags commands can't use, because the globals have them. */
export const RESERVED_SHORTS: readonly string[] = ["h", "V"];

const VALUED = new Set(["--root", "--ref"]);

/**
 * Splits `argv` at the command name: the first token that isn't a flag, skipping the values of
 * `--root` and `--ref`. Scanning stops at `--`, which leaves no command.
 */
export function splitAtCommand(argv: readonly string[]): {
  readonly before: readonly string[];
  readonly command: string | null;
  readonly after: readonly string[];
} {
  let i = 0;
  while (i < argv.length) {
    const token = argv[i] ?? "";
    if (token === "--") break;
    if (token === "-" || !token.startsWith("-")) {
      return { before: argv.slice(0, i), command: token, after: argv.slice(i + 1) };
    }
    i += VALUED.has(token) ? 2 : 1;
  }
  return { before: argv, command: null, after: [] };
}

/** Whether `--json` appears before any `--`, for reporting errors that happen before parsing. */
export function wantsJson(argv: readonly string[]): boolean {
  const end = argv.indexOf("--");
  return (end < 0 ? argv : argv.slice(0, end)).includes("--json");
}
