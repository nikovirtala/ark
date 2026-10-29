import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A git binary that logs every spawn, for `GitOptions.binary`. Not exported from the entry. */
export interface SpawnLog {
  /** The wrapper script: appends its arguments, space-joined, to the log and runs the real git. */
  readonly binary: string;
  /** The temporary directory holding the wrapper and the log. */
  readonly dir: string;
  /** The logged argument lines so far, oldest first. */
  lines(): Promise<string[]>;
  /** How many logged lines contain `fragment`. */
  count(fragment: string): Promise<number>;
  dispose(): Promise<void>;
}

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The git `PATH` finds, as an absolute path. */
export function realGit(): string {
  return execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
}

/** Creates a counting git wrapper in a new temporary directory. */
export async function createSpawnLog(): Promise<SpawnLog> {
  const dir = await mkdtemp(join(tmpdir(), "ledger-spawns-"));
  const log = join(dir, "spawns.log");
  const binary = join(dir, "git");
  await writeFile(log, "");
  await writeFile(
    binary,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(log)}\nexec ${quote(realGit())} "$@"\n`,
  );
  await chmod(binary, 0o755);
  const lines = async () => (await readFile(log, "utf8")).split("\n").filter((l) => l !== "");
  return {
    binary,
    dir,
    lines,
    count: async (fragment) => (await lines()).filter((l) => l.includes(fragment)).length,
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}
