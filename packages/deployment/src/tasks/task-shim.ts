#!/usr/bin/env node
/**
 * Runs a TypeScript (or JavaScript) deployment task module in its own process and speaks the task
 * protocol for it (protocol.ts):
 *
 *   node task-shim.js <module> --needs | --dry-run | --run
 *
 * The module exports `needs`, `dryRun(ctx)` and `run(ctx)`. `--needs` prints the declaration as one
 * JSON line. `--dry-run` and `--run` build the context from the environment the runner gave the
 * process (the role's keys, DEPLOY_TASK_COMMIT, DEPLOY_TASK_OUTPUTS, DEPLOY_TASK_REGION), call the
 * function, and print its result as the last line `{"summary": "..."}`. Anything that goes wrong is
 * an exit of 1 with the reason on stderr.
 *
 * Self-contained on purpose (no imports from the package): it runs from the sources in tests, with
 * Node's type stripping, and from dist/ when installed.
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface Result {
  readonly summary: string;
}

type Ctx = {
  readonly commit: string;
  readonly region: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly outputs: Readonly<Record<string, string>>;
  readonly log: (message: string) => void;
  readonly aws: (args: readonly string[]) => unknown;
};

interface Module {
  readonly needs?: unknown;
  readonly dryRun?: (ctx: Ctx) => Promise<Result>;
  readonly run?: (ctx: Ctx) => Promise<Result>;
}

function context(): Ctx {
  const env = process.env;
  const region = env.DEPLOY_TASK_REGION ?? env.AWS_REGION ?? "";
  let outputs: Record<string, string> = {};
  try {
    outputs = JSON.parse(env.DEPLOY_TASK_OUTPUTS || "{}") as Record<string, string>;
  } catch {
    throw new Error("DEPLOY_TASK_OUTPUTS is not JSON");
  }
  return {
    commit: env.DEPLOY_TASK_COMMIT ?? "",
    region,
    env,
    outputs,
    // Every line goes to stdout, before the summary line: the runner logs it.
    log: (message) => console.log(message),
    aws: (args) => {
      const r = spawnSync(
        "aws",
        [...args, ...(region ? ["--region", region] : []), "--output", "json"],
        {
          env,
          encoding: "utf8",
          maxBuffer: 256 * 1024 * 1024,
        },
      );
      if (r.status !== 0) {
        const why = (r.stderr ?? "").trim().split("\n").slice(-3).join(" ");
        throw new Error(`aws ${args.slice(0, 2).join(" ")} failed: ${why}`);
      }
      return r.stdout.trim().length > 0 ? JSON.parse(r.stdout) : undefined;
    },
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const [file, flag] = argv;
  if (!file || !["--needs", "--dry-run", "--run"].includes(flag ?? "")) {
    console.error("usage: task-shim <module> --needs | --dry-run | --run");
    return 2;
  }
  const mod = (await import(pathToFileURL(path.resolve(file)).href)) as Module;
  if (!mod.needs || typeof mod.dryRun !== "function" || typeof mod.run !== "function") {
    console.error(`${path.basename(file)}: a deployment task module exports needs, dryRun and run`);
    return 1;
  }
  if (flag === "--needs") {
    console.log(JSON.stringify(mod.needs));
    return 0;
  }
  const fn = flag === "--dry-run" ? mod.dryRun : mod.run;
  const result = await fn(context());
  if (typeof result?.summary !== "string") {
    console.error(
      `${path.basename(file)}: ${flag === "--dry-run" ? "dryRun" : "run"} returned no { summary }`,
    );
    return 1;
  }
  console.log(JSON.stringify({ summary: result.summary }));
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
