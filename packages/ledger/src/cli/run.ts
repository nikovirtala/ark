import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import {
  CommitFailedError,
  InvalidArgumentError,
  type JsonValue,
  LedgerError,
  UsageError,
} from "../errors.js";
import {
  GLOBAL_OPTIONS,
  type GlobalFlags,
  RESERVED_SHORTS,
  splitAtCommand,
  wantsJson,
} from "./flags.js";
import type { CliIO } from "./output.js";

/** A command's result: `json` for `--json`, else `text`; `notes` go to stderr either way. */
export interface Outcome {
  readonly exit: 0 | 1;
  readonly json: JsonValue;
  readonly text: string;
  readonly notes?: readonly string[];
}

export interface CommandSpec {
  readonly name: string;
  /** One line, for `<tool> --help`. */
  readonly summary: string;
  /** For example `show <decision> [--history]`. */
  readonly usage: string;
  /** `node:util` `parseArgs` options; `runCli` adds the globals. */
  readonly options: ParseArgsOptionsConfig;
  readonly positionals: {
    readonly min: number;
    readonly max: number;
    readonly names: readonly string[];
  };
  /** Whether the command accepts `--ref` (reads) or refuses it (writes). */
  readonly ref: "read" | "reject";
  run(ctx: {
    readonly io: CliIO;
    readonly flags: GlobalFlags;
    /** The parsed command options, without the globals. */
    readonly values: Readonly<Record<string, unknown>>;
    readonly positionals: readonly string[];
  }): Promise<Outcome>;
}

export interface ToolCli {
  readonly name: string;
  readonly version: string;
  readonly summary: string;
  readonly commands: readonly CommandSpec[];
}

const GLOBAL_HELP: readonly (readonly [flag: string, text: string, ref?: true])[] = [
  ["--json", "print one JSON document on stdout"],
  ["--root <dir>", "the log directory (default: from the config)"],
  ["--ref <ref>", "read the log as of a git ref", true],
  ["-h, --help", "show help"],
  ["-V, --version", "print the version"],
];

function table(rows: readonly (readonly [string, string])[]): string {
  const width = Math.max(...rows.map(([a]) => a.length));
  return rows.map(([a, b]) => `  ${a.padEnd(width)}  ${b}`.trimEnd()).join("\n");
}

function toolHelp(tool: ToolCli): string {
  const commands = tool.commands.map((c) => [c.name, c.summary] as const);
  const globals = GLOBAL_HELP.map(([flag, text]) => [flag, text] as const);
  return [
    `Usage: ${tool.name} [global options] <command> [options]`,
    "",
    tool.summary,
    "",
    "Commands:",
    table([...commands, ["help [command]", "show help for a command"]]),
    "",
    "Global options:",
    table(globals),
    "",
  ].join("\n");
}

function commandHelp(tool: ToolCli, spec: CommandSpec): string {
  const options = Object.entries(spec.options).map(([name, o]) => {
    const flag = `${o.short === undefined ? "" : `-${o.short}, `}--${name}`;
    const value = o.type === "string" ? ` <value>` : "";
    return [`${flag}${value}`, o.multiple === true ? "(repeatable)" : ""] as const;
  });
  const globals = GLOBAL_HELP.filter(([, , ref]) => ref !== true || spec.ref === "read").map(
    ([flag, text]) => [flag, text] as const,
  );
  return [
    `Usage: ${tool.name} ${spec.usage}`,
    "",
    spec.summary,
    "",
    ...(options.length === 0 ? [] : ["Options:", table(options), ""]),
    "Global options:",
    table(globals),
    "",
  ].join("\n");
}

/** Programming errors in a tool definition (design §4.9 step 0). */
function checkTool(tool: ToolCli): void {
  const names = new Set<string>(["help"]);
  for (const c of tool.commands) {
    if (names.has(c.name)) {
      throw new InvalidArgumentError(
        c.name === "help"
          ? `${tool.name}: the command name help is reserved`
          : `${tool.name}: command ${c.name} is defined twice`,
      );
    }
    names.add(c.name);
    for (const [key, o] of Object.entries(c.options)) {
      if (Object.hasOwn(GLOBAL_OPTIONS, key)) {
        throw new InvalidArgumentError(`${tool.name} ${c.name}: --${key} is a global flag`);
      }
      if (o.short !== undefined && RESERVED_SHORTS.includes(o.short)) {
        throw new InvalidArgumentError(`${tool.name} ${c.name}: -${o.short} is a global flag`);
      }
    }
  }
}

function isParseArgsError(e: unknown): e is Error {
  const code: unknown = e instanceof Error ? (e as Error & { code?: unknown }).code : undefined;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_");
}

/** `parseArgs` with its errors as `UsageError`s. */
function parse(
  args: readonly string[],
  options: ParseArgsOptionsConfig,
  allowPositionals: boolean,
): { values: Record<string, unknown>; positionals: string[] } {
  try {
    const r = parseArgs({
      args: [...args],
      options,
      strict: true,
      allowPositionals,
      allowNegative: true,
    });
    return { values: { ...r.values }, positionals: r.positionals };
  } catch (e) {
    if (isParseArgsError(e)) throw new UsageError(e.message, { cause: e });
    throw e;
  }
}

function globalString(values: Record<string, unknown>, key: "root" | "ref"): string | null {
  const v = values[key];
  if (typeof v !== "string") return null;
  if (v.trim() === "") throw new UsageError(`--${key} must not be empty`);
  return v;
}

/**
 * Runs one invocation of a tool (design §4.9): globals before or after the command, help and
 * version, usage checks, dispatch, output and exit code. Never throws: a `LedgerError` exits 2
 * with `<tool>: error: …`, anything else exits 2 with `<tool>: internal error: …` and the stack;
 * with `--json`, stdout also gets an `ark-error/v1` document. A `CommitFailedError`'s notes that
 * its message doesn't already hold are printed as warnings before the error, and are the
 * document's `notes`.
 */
export async function runCli(tool: ToolCli, io: CliIO): Promise<0 | 1 | 2> {
  let json = wantsJson(io.argv);
  const fail = (e: unknown, internal: boolean): 2 => {
    const known = !internal && e instanceof LedgerError;
    const message = e instanceof Error ? e.message : String(e);
    // A failed commit's command notes come first, as on success; the hint already says some.
    const notes =
      known && e instanceof CommitFailedError ? e.notes.filter((n) => !message.includes(n)) : null;
    for (const note of notes ?? []) io.stderr.write(`${tool.name}: warning: ${note}\n`);
    if (known) {
      io.stderr.write(`${tool.name}: error: ${message}\n`);
    } else {
      const stack = e instanceof Error && e.stack !== undefined ? `${e.stack}\n` : "";
      io.stderr.write(`${tool.name}: internal error: ${message}\n${stack}`);
    }
    if (json) {
      const error = { code: known ? e.code : "internal", message };
      const doc = { format: "ark-error/v1", error, ...(notes === null ? {} : { notes }) };
      io.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
    }
    return 2;
  };

  try {
    checkTool(tool);
  } catch (e) {
    return fail(e, true);
  }

  try {
    const { before, command, after } = splitAtCommand(io.argv);
    if (command === null) {
      const { values } = parse(before, GLOBAL_OPTIONS, false);
      json = values.json === true;
      if (values.version === true) {
        io.stdout.write(`${tool.version}\n`);
        return 0;
      }
      if (values.help === true) {
        io.stdout.write(toolHelp(tool));
        return 0;
      }
      io.stderr.write(toolHelp(tool));
      throw new UsageError("missing command");
    }
    if (command === "help") {
      const { values, positionals } = parse([...before, ...after], GLOBAL_OPTIONS, true);
      json = values.json === true;
      if (positionals.length > 1) {
        throw new UsageError(`unexpected argument ${JSON.stringify(positionals[1])}`);
      }
      const name = positionals[0];
      const spec = name === undefined ? null : tool.commands.find((c) => c.name === name);
      if (spec === undefined) throw new UsageError(`unknown command ${JSON.stringify(name)}`);
      io.stdout.write(spec === null ? toolHelp(tool) : commandHelp(tool, spec));
      return 0;
    }
    const spec = tool.commands.find((c) => c.name === command);
    if (spec === undefined) {
      throw new UsageError(
        `unknown command ${JSON.stringify(command)}; run '${tool.name} --help' for the commands`,
      );
    }
    const { values, positionals } = parse(
      [...before, ...after],
      { ...GLOBAL_OPTIONS, ...spec.options },
      true,
    );
    json = values.json === true;
    if (values.version === true) {
      io.stdout.write(`${tool.version}\n`);
      return 0;
    }
    if (values.help === true) {
      io.stdout.write(commandHelp(tool, spec));
      return 0;
    }
    const usage = `usage: ${tool.name} ${spec.usage}`;
    const { min, max, names } = spec.positionals;
    if (positionals.length < min) {
      throw new UsageError(
        `missing argument <${names[positionals.length] ?? "argument"}>; ${usage}`,
      );
    }
    if (positionals.length > max) {
      throw new UsageError(`unexpected argument ${JSON.stringify(positionals[max])}; ${usage}`);
    }
    const flags: GlobalFlags = {
      json,
      root: globalString(values, "root"),
      ref: globalString(values, "ref"),
    };
    if (flags.ref !== null && spec.ref === "reject") {
      throw new UsageError(`${spec.name} does not take --ref; it works on the work tree`);
    }
    const own: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) if (!Object.hasOwn(GLOBAL_OPTIONS, k)) own[k] = v;

    const outcome = await spec.run({ io, flags, values: own, positionals });
    if (json) {
      io.stdout.write(`${JSON.stringify(outcome.json, null, 2)}\n`);
    } else if (outcome.text !== "") {
      io.stdout.write(outcome.text.endsWith("\n") ? outcome.text : `${outcome.text}\n`);
    }
    for (const note of outcome.notes ?? []) io.stderr.write(`${tool.name}: warning: ${note}\n`);
    return outcome.exit;
  } catch (e) {
    return fail(e, false);
  }
}
