import { resolve } from "node:path";
import {
  findingsReport,
  formatText,
  type HookManager,
  type JsonValue,
  UsageError,
} from "@nikovirtala/ledger";
import type { CommandSpec, Outcome } from "@nikovirtala/ledger/cli";
import {
  addHookTrailers,
  type IssueHooksJson,
  installIssueHooks,
  printIssueHooks,
  runPreCommitHook,
  uninstallIssueHooks,
} from "../hooks.js";
import { openForCli } from "./open.js";

const USAGE =
  "hooks install | uninstall | print --manager lefthook|husky|pre-commit | run pre-commit | trailers <message-file>";
const MANAGERS: readonly HookManager[] = ["lefthook", "husky", "pre-commit"];

const outcome = (doc: IssueHooksJson, text: string, notes: readonly string[]): Outcome => ({
  exit: 0,
  json: doc as unknown as JsonValue,
  text,
  notes,
});

/**
 * `issues hooks install | uninstall | print --manager … | run pre-commit | trailers <message-file>`
 * (adr's command, ADR-0011): issues' git hooks through ledger's shims, shared with other ark tools.
 */
export const hooksCommand: CommandSpec = {
  name: "hooks",
  summary: "install, remove or print issues' git hooks, and run their steps",
  usage: USAGE,
  options: { manager: { type: "string" } },
  help: {
    manager: { value: "<manager>", text: "with print: lefthook, husky or pre-commit" },
  },
  positionals: { min: 1, max: 2, names: ["action", "argument"] },
  ref: "reject",
  async run({ io, flags, values, positionals }) {
    const [action = "", argument] = positionals;
    const manager = values.manager;
    if (manager !== undefined && action !== "print") {
      throw new UsageError(`--manager goes with hooks print only; usage: issues ${USAGE}`);
    }
    const noArgument = () => {
      if (argument !== undefined) {
        throw new UsageError(
          `unexpected argument ${JSON.stringify(argument)}; usage: issues ${USAGE}`,
        );
      }
    };
    switch (action) {
      case "install": {
        noArgument();
        const log = await openForCli(io, flags);
        const doc = await installIssueHooks(log);
        const lines = [
          ...[...doc.written, ...doc.unchanged]
            .map((p) => `${doc.written.includes(p) ? "wrote" : "unchanged"} ${p}`)
            .sort((a, b) => order(a) - order(b)),
          `issues hooks: ${doc.registrations.map((r) => r.hook).join(", ")}`,
        ];
        return outcome(doc, lines.join("\n"), log.notes);
      }
      case "uninstall": {
        noArgument();
        const log = await openForCli(io, flags);
        const doc = await uninstallIssueHooks(log);
        const text =
          doc.written.length === 0
            ? "issues hooks were not installed"
            : doc.written.map((p) => `removed issues from ${p}`).join("\n");
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
        const log = await openForCli(io, flags);
        const doc = printIssueHooks(log, manager as HookManager);
        return outcome(doc, doc.snippet ?? "", log.notes);
      }
      case "run": {
        if (argument !== "pre-commit") throw new UsageError("issues hooks run supports pre-commit");
        const worktree = await openForCli(io, flags);
        const index = await openForCli(io, flags, { reader: "index" });
        const r = await runPreCommitHook({ worktree, index, env: io.env });
        return {
          exit: r.exit,
          json: findingsReport(r.findings, { failOn: r.failOn }) as unknown as JsonValue,
          text: r.findings.length === 0 ? "" : formatText(r.findings),
          notes: r.notes,
        };
      }
      case "trailers": {
        if (argument === undefined) {
          throw new UsageError(`missing argument <message-file>; usage: issues ${USAGE}`);
        }
        const log = await openForCli(io, flags);
        const doc = await addHookTrailers(log, resolve(io.cwd, argument));
        return outcome(doc, "", [...log.notes, ...doc.notes]);
      }
      default:
        throw new UsageError(
          `unknown hooks action ${JSON.stringify(action)}; use install, uninstall, print, run or trailers`,
        );
    }
  },
};

/** A shim line's rank in hook order, for the install text. */
function order(line: string): number {
  return ["pre-commit", "commit-msg", "pre-push", "post-merge"].findIndex((h) =>
    line.endsWith(`/${h}`),
  );
}
