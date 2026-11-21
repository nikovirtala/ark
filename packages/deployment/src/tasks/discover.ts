/**
 * Finding a project's deployment tasks: one file per task in its tasks directory (`tasks/`, or
 * longplay's `release/`), named `<n>[.<m>…]-<slug>[.<ext>]` and run in numeric order (2.6 before 3.7
 * before 10.1). A file that does not match the naming rule is an error, not skipped, so a task is
 * never left out by a typo.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * How a task file is run: a `module` (TypeScript or JavaScript exporting needs, dryRun and run) by
 * the package's shim, an `interpreted` file by the interpreter its extension maps to, an
 * `executable` by itself.
 */
export type TaskKind = "module" | "interpreted" | "executable";

export interface TaskFile {
  readonly id: string;
  readonly file: string;
  readonly kind: TaskKind;
  /** The extension, with its dot, or "" for none. */
  readonly ext: string;
  /** The numeric id's parts, for ordering. */
  readonly order: readonly number[];
}

export const MODULE_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".mts", ".js", ".mjs"]);

const FILE_NAME = /^(\d+(?:\.\d+)*)-([a-z0-9]+(?:-[a-z0-9]+)*)(\.[A-Za-z0-9]+)?$/;

export interface DiscoverOptions {
  /** Extensions run by an interpreter (`.py` → `["python3"]`). */
  readonly interpreters?: Readonly<Record<string, readonly string[]>>;
}

function compareOrder(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/** The kind and extension of a task file name, or an error message when the name breaks the rule. */
export function classifyTaskFile(
  name: string,
  mode: number,
  options: DiscoverOptions = {},
): { id: string; kind: TaskKind; ext: string; order: number[] } | { error: string } {
  const m = FILE_NAME.exec(name);
  if (!m) {
    return {
      error: `${name} is not named <n>[.<m>]-<slug>[.<ext>] (a task number, then a slug in lower case)`,
    };
  }
  const ext = m[3] ?? "";
  const id = ext ? name.slice(0, -ext.length) : name;
  const order = (m[1] as string).split(".").map(Number);
  if (MODULE_EXTENSIONS.has(ext)) return { id, kind: "module", ext, order };
  if (options.interpreters && ext in options.interpreters) {
    return { id, kind: "interpreted", ext, order };
  }
  if ((mode & 0o111) !== 0) return { id, kind: "executable", ext, order };
  return {
    error: `${name} is neither a module (.ts, .js), nor a file with an interpreter in deploy.toml, nor executable`,
  };
}

/** The task files of a directory, in task order. A missing directory has none. */
export function discoverTasks(dir: string, options: DiscoverOptions = {}): TaskFile[] {
  if (!fs.existsSync(dir)) return [];
  const found: TaskFile[] = [];
  const label = path.basename(dir);
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (name.startsWith(".") || name.endsWith(".md") || fs.statSync(full).isDirectory()) continue;
    const c = classifyTaskFile(name, fs.statSync(full).mode, options);
    if ("error" in c) throw new Error(`${label}/${c.error}`);
    found.push({ id: c.id, file: full, kind: c.kind, ext: c.ext, order: c.order });
  }
  const ids = new Set<string>();
  for (const f of found) {
    if (ids.has(f.id)) throw new Error(`task id ${f.id} is in more than one file in ${label}/`);
    ids.add(f.id);
  }
  return found.sort((a, b) => compareOrder(a.order, b.order) || a.id.localeCompare(b.id));
}

/** The task files whose ids are in the ledger: done, and safe to delete (tidying up, never required). */
export function deletable(
  tasks: readonly TaskFile[],
  done: ReadonlySet<string>,
  cwd: string = process.cwd(),
): string[] {
  return tasks.filter((t) => done.has(t.id)).map((t) => path.relative(cwd, t.file) || t.file);
}
