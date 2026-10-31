import { resolve } from "node:path";
import { type JsonValue, UsageError } from "../errors.js";
import { findingsReport, formatText } from "../findings/format.js";
import type { HookManager } from "../hooks/snippets.js";
import type { PreCommitHookResult } from "../surfaces/hook-steps.js";
import type { ToolHooksJson } from "../surfaces/tool-hooks.js";
import type { GlobalFlags } from "./flags.js";
import type { CliIO } from "./output.js";
import type { CommandSpec, Outcome } from "./run.js";

export interface HooksCommandOptions<L extends { readonly notes: readonly string[] }> {
  /** The tool's name, for the summary, the text and the usage errors. */
  readonly tool: string;
  /** The tool's name in the possessive, for the summary; default `<tool>'s` (issues passes `issues'`). */
  readonly possessive?: string;
  /** `--manager`'s placeholder and help line; without it `--help` lists the option without them. */
  readonly manager?: { readonly value: string; readonly help: string };
  /** Opens the tool's log with the work-tree or the index reader. */
  open(ctx: {
    readonly io: CliIO;
    readonly flags: GlobalFlags;
    readonly reader: "worktree" | "index";
  }): Promise<L>;
  install(log: L): Promise<ToolHooksJson>;
  uninstall(log: L): Promise<ToolHooksJson>;
  print(log: L, manager: HookManager): ToolHooksJson;
  /** The pre-commit step (`runPreCommitHook`). */
  preCommit(o: {
    readonly worktree: L;
    readonly index: L;
    readonly env: NodeJS.ProcessEnv;
  }): Promise<PreCommitHookResult>;
  /** The commit-msg step on the absolute message file; its `notes`, if any, follow the log's. */
  trailers(
    log: L,
    messageFile: string,
  ): Promise<ToolHooksJson & { readonly notes?: readonly string[] }>;
}

const USAGE =
  "hooks install | uninstall | print --manager lefthook|husky|pre-commit | run pre-commit | trailers <message-file>";
const MANAGERS: readonly HookManager[] = ["lefthook", "husky", "pre-commit"];
const HOOK_ORDER = ["pre-commit", "commit-msg", "pre-push", "post-merge"];

const outcome = (doc: ToolHooksJson, text: string, notes: readonly string[]): Outcome => ({
  exit: 0,
  json: doc as unknown as JsonValue,
  text,
  notes,
});

/** A shim line's rank in hook order, for the install text. */
const order = (line: string): number => HOOK_ORDER.findIndex((h) => line.endsWith(`/${h}`));

/**
 * The shared `hooks install | uninstall | print --manager … | run pre-commit | trailers
 * <message-file>` command (design 2b D4, D8, §4.3): the tool's git hooks through ledger's shims,
 * shared with other ark tools.
 */
export function hooksCommand<L extends { readonly notes: readonly string[] }>(
  o: HooksCommandOptions<L>,
): CommandSpec {
  const { tool } = o;
  return {
    name: "hooks",
    summary: `install, remove or print ${o.possessive ?? `${tool}'s`} git hooks, and run their steps`,
    usage: USAGE,
    options: {
      manager:
        o.manager === undefined
          ? { type: "string" }
          : { type: "string", value: o.manager.value, help: o.manager.help },
    },
    positionals: { min: 1, max: 2, names: ["action", "argument"] },
    ref: "reject",
    async run({ io, flags, values, positionals }) {
      const [action = "", argument] = positionals;
      const manager = values.manager;
      if (manager !== undefined && action !== "print") {
        throw new UsageError(`--manager goes with hooks print only; usage: ${tool} ${USAGE}`);
      }
      const noArgument = () => {
        if (argument !== undefined) {
          throw new UsageError(
            `unexpected argument ${JSON.stringify(argument)}; usage: ${tool} ${USAGE}`,
          );
        }
      };
      const open = (reader: "worktree" | "index") => o.open({ io, flags, reader });
      switch (action) {
        case "install": {
          noArgument();
          const log = await open("worktree");
          const doc = await o.install(log);
          const lines = [
            ...[...doc.written, ...doc.unchanged]
              .map((p) => `${doc.written.includes(p) ? "wrote" : "unchanged"} ${p}`)
              .sort((a, b) => order(a) - order(b)),
            `${tool} hooks: ${doc.registrations.map((r) => r.hook).join(", ")}`,
          ];
          return outcome(doc, lines.join("\n"), log.notes);
        }
        case "uninstall": {
          noArgument();
          const log = await open("worktree");
          const doc = await o.uninstall(log);
          const text =
            doc.written.length === 0
              ? `${tool} hooks were not installed`
              : doc.written.map((p) => `removed ${tool} from ${p}`).join("\n");
          return outcome(doc, text, log.notes);
        }
        case "print": {
          noArgument();
          if (manager === undefined) {
            throw new UsageError("hooks print needs --manager lefthook, husky or pre-commit");
          }
          if (!(MANAGERS as readonly unknown[]).includes(manager)) {
            throw new UsageError(
              `unknown hook manager ${JSON.stringify(manager)}; use lefthook, husky or pre-commit`,
            );
          }
          const log = await open("worktree");
          const doc = o.print(log, manager as HookManager);
          return outcome(doc, doc.snippet ?? "", log.notes);
        }
        case "run": {
          if (argument !== "pre-commit") {
            throw new UsageError(`${tool} hooks run supports pre-commit`);
          }
          const worktree = await open("worktree");
          const index = await open("index");
          const r = await o.preCommit({ worktree, index, env: io.env });
          return {
            exit: r.exit,
            json: findingsReport(r.findings, { failOn: r.failOn }) as unknown as JsonValue,
            text: r.findings.length === 0 ? "" : formatText(r.findings),
            notes: r.notes,
          };
        }
        case "trailers": {
          if (argument === undefined) {
            throw new UsageError(`missing argument <message-file>; usage: ${tool} ${USAGE}`);
          }
          const log = await open("worktree");
          const doc = await o.trailers(log, resolve(io.cwd, argument));
          return outcome(doc, "", [...log.notes, ...(doc.notes ?? [])]);
        }
        default:
          throw new UsageError(
            `unknown hooks action ${JSON.stringify(action)}; use install, uninstall, print, run or trailers`,
          );
      }
    },
  };
}
