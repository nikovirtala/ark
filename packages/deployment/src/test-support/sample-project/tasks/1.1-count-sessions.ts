/**
 * A sample deployment task in TypeScript, for the tests and the CLI demo: a module that exports
 * needs, dryRun and run. The package's shim runs it in its own process.
 */
interface Ctx {
  readonly commit: string;
  readonly outputs: Readonly<Record<string, string>>;
  readonly log: (message: string) => void;
}

export const needs = {
  role: "sample-deployment-task-count",
  description: "Counts what a first deploy left behind (a sample).",
  outputs: ["TableName"],
};

export async function dryRun(ctx: Ctx) {
  ctx.log(`reading ${ctx.outputs.TableName ?? "(no table)"}`);
  return {
    summary: `would count the items of ${ctx.outputs.TableName ?? "(no table)"} for ${ctx.commit.slice(0, 7)}`,
  };
}

export async function run(ctx: Ctx) {
  return { summary: `counted 0 items of ${ctx.outputs.TableName ?? "(no table)"}` };
}
