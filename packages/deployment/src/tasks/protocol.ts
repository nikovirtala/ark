/**
 * The deployment task protocol. A task is any executable that answers three flags:
 *
 *   --needs     one JSON line: {"role": "...", "description": "...", "outputs": ["..."]}
 *   --dry-run   changes nothing, says what the run would do; a last line {"summary": "..."}
 *   --run       does it; a last line {"summary": "..."}
 *
 * A non-zero exit is a failure. The task gets its declared role's keys in its environment, the
 * commit in DEPLOY_TASK_COMMIT and the stack outputs it declared, as JSON, in DEPLOY_TASK_OUTPUTS
 * (and under the project's own names too, such as longplay's LP_RELEASE_COMMIT and
 * LP_RELEASE_OUTPUTS). A TypeScript module that exports `needs`, `dryRun(ctx)` and `run(ctx)` is
 * run by the package's shim (task-shim.ts), in its own process, and speaks the same protocol.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type Env, type Exec, tail } from "../aws.js";
import type { TaskFile } from "./discover.js";

export interface TaskNeeds {
  /** The role to run as: one with the project's task role prefix, never the deploy role. */
  readonly role: string;
  /** What the task does, in a sentence. */
  readonly description: string;
  /** The stack outputs it reads (given to it as `ctx.outputs`). */
  readonly outputs?: readonly string[];
}

export interface TaskContext {
  readonly commit: string;
  readonly region: string;
  /** The environment the task runs in: its declared role's keys. */
  readonly env: Env;
  /** The stack outputs it declared. */
  readonly outputs: Readonly<Record<string, string>>;
  readonly log: (message: string) => void;
  /** `aws <args> --output json` as the declared role, parsed. */
  readonly aws: (args: readonly string[]) => unknown;
}

export interface TaskResult {
  /** One line, no data: counts and names. It goes in the ledger and the log. */
  readonly summary: string;
}

/** What a TypeScript task module exports. */
export interface TaskModule {
  readonly needs: TaskNeeds;
  dryRun(ctx: TaskContext): Promise<TaskResult>;
  run(ctx: TaskContext): Promise<TaskResult>;
}

export type TaskMode = "dry-run" | "run";

/** Runs a task file. A seam: the real one starts a process that speaks the protocol. */
export interface TaskExecutor {
  needs(task: TaskFile): Promise<TaskNeeds>;
  execute(task: TaskFile, mode: TaskMode, ctx: TaskContext): Promise<TaskResult>;
}

export const needsSchema = z.object({
  role: z.string().min(1),
  description: z.string().min(1),
  outputs: z.array(z.string().min(1)).optional(),
});

/** The variables a task reads, under the package's names. */
export const TASK_ENV = {
  commit: "DEPLOY_TASK_COMMIT",
  outputs: "DEPLOY_TASK_OUTPUTS",
  region: "DEPLOY_TASK_REGION",
} as const;

export interface TaskEnvNames {
  readonly commit: string;
  readonly outputs: string;
}

/** The last line of output that starts with `{`, parsed. */
export function lastJsonLine(stdout: string): unknown {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (line.startsWith("{")) return JSON.parse(line);
  }
  throw new Error("the task printed no JSON line");
}

/** Parses what `--needs` printed. Throws with what is wrong. */
export function parseNeeds(id: string, stdout: string): TaskNeeds {
  let raw: unknown;
  try {
    raw = lastJsonLine(stdout);
  } catch (err) {
    throw new Error(`${id} --needs: ${(err as Error).message}`);
  }
  const parsed = needsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${id}: needs must be { role, description, outputs? } (${parsed.error.issues.map((i) => `${i.path.join(".") || "needs"}: ${i.message}`).join("; ")})`,
    );
  }
  const { role, description, outputs } = parsed.data;
  return { role, description, ...(outputs ? { outputs } : {}) };
}

/** Where the shim is: next to the bundle in dist/, or next to this file in the sources. */
export function shimPath(): string {
  for (const name of ["./task-shim.js", "./task-shim.ts"]) {
    const p = fileURLToPath(new URL(name, import.meta.url));
    if (fs.existsSync(p)) return p;
  }
  throw new Error("the deployment task shim (task-shim.js) is missing from the package");
}

export interface ProcessExecutorOptions {
  readonly exec: Exec;
  /** The repository root: every task runs here. */
  readonly cwd: string;
  /** The environment `--needs` runs in (no role is assumed for it). */
  readonly baseEnv: Env;
  readonly interpreters?: Readonly<Record<string, readonly string[]>>;
  /** The project's own names for the commit and the outputs, set beside the package's. */
  readonly envNames?: TaskEnvNames;
  /** The Node binary that runs the shim. Default: this process's. */
  readonly node?: string;
}

/** The real executor: every task in its own process, through the protocol. */
export class ProcessExecutor implements TaskExecutor {
  private readonly o: ProcessExecutorOptions;

  constructor(options: ProcessExecutorOptions) {
    this.o = options;
  }

  /** The command and arguments that run a task with a flag. */
  command(task: TaskFile, flag: string): [string, string[]] {
    const file = path.resolve(task.file);
    if (task.kind === "module") return [this.o.node ?? process.execPath, [shimPath(), file, flag]];
    if (task.kind === "interpreted") {
      const argv = this.o.interpreters?.[task.ext];
      if (!argv || argv.length === 0) throw new Error(`${task.id}: no interpreter for ${task.ext}`);
      return [argv[0] as string, [...argv.slice(1), file, flag]];
    }
    return [file, [flag]];
  }

  async needs(task: TaskFile): Promise<TaskNeeds> {
    const [cmd, args] = this.command(task, "--needs");
    const r = this.o.exec(cmd, args, { env: this.o.baseEnv, cwd: this.o.cwd });
    if (r.status !== 0)
      throw new Error(`${task.id} --needs failed: exit ${String(r.status)}: ${tail(r.stderr)}`);
    return parseNeeds(task.id, r.stdout);
  }

  async execute(task: TaskFile, mode: TaskMode, ctx: TaskContext): Promise<TaskResult> {
    const outputs = JSON.stringify(ctx.outputs);
    const env: Record<string, string | undefined> = {
      ...ctx.env,
      [TASK_ENV.commit]: ctx.commit,
      [TASK_ENV.outputs]: outputs,
      [TASK_ENV.region]: ctx.region,
    };
    if (this.o.envNames) {
      env[this.o.envNames.commit] = ctx.commit;
      env[this.o.envNames.outputs] = outputs;
    }
    const [cmd, args] = this.command(task, `--${mode}`);
    const r = this.o.exec(cmd, args, { env, cwd: this.o.cwd });
    for (const line of r.stdout.split("\n")) if (line.trim()) ctx.log(line);
    if (r.status !== 0) throw new Error(`exit ${String(r.status)}: ${tail(r.stderr)}`);
    let out: { summary?: unknown };
    try {
      out = lastJsonLine(r.stdout) as { summary?: unknown };
    } catch {
      throw new Error(`${task.id}: ${mode} printed no {"summary": ...}`);
    }
    if (typeof out.summary !== "string")
      throw new Error(`${task.id}: ${mode} printed no {"summary": ...}`);
    return { summary: out.summary };
  }
}
