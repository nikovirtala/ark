import { UsageError } from "@nikovirtala/ledger";
import type { CliIO, GlobalFlags } from "@nikovirtala/ledger/cli";
import { type IssueLog, openIssueLog } from "../log.js";

/**
 * The issue log a command works on: `--root` and `--ref` from the globals, git run with the
 * CLI's environment.
 */
export function openForCli(
  io: CliIO,
  flags: GlobalFlags,
  o: { readonly reader?: "worktree" | "index" } = {},
): Promise<IssueLog> {
  return openIssueLog({
    cwd: io.cwd,
    root: flags.root,
    ref: flags.ref,
    ...(o.reader === undefined ? {} : { reader: o.reader }),
    gitOptions: { env: io.env },
  });
}

/** A repeatable string option's values. */
export const strings = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

/** `--limit`: an integer from 1 to 1000, or `null` when absent. */
export function limitOf(v: unknown): number | null {
  if (v === undefined) return null;
  const n = typeof v === "string" && /^[0-9]+$/.test(v.trim()) ? Number(v.trim()) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    throw new UsageError("--limit must be an integer from 1 to 1000");
  }
  return n;
}
