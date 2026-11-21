/**
 * The check runner: a project lists its smoke checks, and this runs them, turns a check that throws
 * into a FAIL, and prints the results (`--json` for the pipeline's stage). `--dry-run` runs nothing
 * against AWS: it gives every check a stub runner that records the calls it would make and answers
 * nothing, and prints each check with those calls and whether each is read-only.
 *
 *   // scripts/smoke.ts in a project
 *   import { smokeMain } from "@nikovirtala/deployment";
 *   await smokeMain(CHECKS, { region: "eu-north-1" });
 */
import {
  type Add,
  type AwsRunner,
  isReadOnlyCommand,
  READ_ONLY_EXCEPTIONS,
  readOnlyAws,
  render,
} from "./helpers.js";
import type { Result } from "./verdict.js";

/** What a check gets: the read-only AWS runner, a way to report results, the clock and HTTP. */
export interface CheckContext {
  readonly aws: AwsRunner;
  readonly add: Add;
  readonly now: () => Date;
  readonly fetch: typeof fetch;
}

export interface SmokeCheck {
  /** The task the check belongs to (a plan task id, or a name). */
  readonly task: string;
  readonly name: string;
  run(ctx: CheckContext): void | Promise<void>;
}

export interface RunChecksOptions {
  readonly aws: AwsRunner;
  readonly now?: () => Date;
  readonly fetch?: typeof fetch;
}

/** Runs every check in order. A check that throws reports one FAIL for itself; the others still run. */
export async function runChecks(
  checks: readonly SmokeCheck[],
  options: RunChecksOptions,
): Promise<Result[]> {
  const results: Result[] = [];
  for (const check of checks) {
    const add: Add = (task, name, status, detail = "") => {
      results.push({ task, name, status, detail });
    };
    try {
      await check.run({
        aws: options.aws,
        add,
        now: options.now ?? (() => new Date()),
        fetch: options.fetch ?? fetch,
      });
    } catch (err) {
      add(check.task, check.name, "FAIL", `the check crashed: ${(err as Error).message}`);
    }
  }
  return results;
}

export interface PlannedCall {
  readonly call: string;
  readonly readOnly: boolean;
}

export interface PlannedCheck {
  readonly task: string;
  readonly name: string;
  readonly calls: readonly PlannedCall[];
  /** True when the check stopped at the stub's empty answers before its last call. */
  readonly stoppedEarly: boolean;
}

/**
 * What each check would call, without calling anything: the AWS runner records the call and answers
 * nothing, and HTTP requests are recorded and answered with 599.
 */
export async function dryRunChecks(
  checks: readonly SmokeCheck[],
  exceptions: readonly string[] = [],
): Promise<PlannedCheck[]> {
  const planned: PlannedCheck[] = [];
  for (const check of checks) {
    const calls: PlannedCall[] = [];
    const aws: AwsRunner = (service, command, args = []) => {
      calls.push({
        call: `aws ${service} ${command}${args.length > 0 ? ` ${args.join(" ")}` : ""}`,
        readOnly: isReadOnlyCommand(service, command, [...READ_ONLY_EXCEPTIONS, ...exceptions]),
      });
      return undefined;
    };
    const stubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({
        call: `${init?.method ?? "GET"} ${url}`,
        readOnly: (init?.method ?? "GET") === "GET",
      });
      return new Response(null, { status: 599 });
    }) as typeof fetch;
    let stoppedEarly = false;
    try {
      await check.run({ aws, add: () => undefined, now: () => new Date(), fetch: stubFetch });
    } catch {
      stoppedEarly = true;
    }
    planned.push({ task: check.task, name: check.name, calls, stoppedEarly });
  }
  return planned;
}

export function renderPlan(planned: readonly PlannedCheck[]): string {
  const lines: string[] = [];
  for (const p of planned) {
    lines.push(`DRY   ${p.task}  ${p.name}`);
    for (const c of p.calls) lines.push(`        ${c.readOnly ? "read " : "WRITE"} ${c.call}`);
    if (p.calls.length === 0) lines.push("        (no AWS or HTTP call)");
    if (p.stoppedEarly)
      lines.push("        (stopped at the dry run's empty answers; a real run makes more calls)");
  }
  return lines.join("\n");
}

export interface SmokeMainOptions {
  readonly region: string;
  /** More read-only sub-commands the checks use, as `<service> <command>`. */
  readonly exceptions?: readonly string[];
  readonly argv?: readonly string[];
  readonly print?: (text: string) => void;
  /** The runner, for tests. Default: the read-only AWS CLI. */
  readonly aws?: AwsRunner;
}

/**
 * The main of a project's check script: `--json` prints the results as JSON (what the stage reads),
 * `--dry-run` prints the plan, anything else prints one line per result. Returns the exit code:
 * 0 with no FAIL, 1 with one, and 1 for a dry run that would make a call that is not read-only.
 */
export async function smokeMain(
  checks: readonly SmokeCheck[],
  options: SmokeMainOptions,
): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const print = options.print ?? ((t: string) => console.log(t));
  if (argv.includes("--dry-run")) {
    const planned = await dryRunChecks(checks, options.exceptions);
    if (argv.includes("--json")) print(JSON.stringify(planned, null, 2));
    else print(renderPlan(planned));
    const writes = planned.flatMap((p) => p.calls).filter((c) => !c.readOnly).length;
    if (!argv.includes("--json")) {
      print(
        `\n${planned.length} check(s), ${planned.reduce((n, p) => n + p.calls.length, 0)} call(s), ${writes === 0 ? "all read-only" : `${writes} NOT READ-ONLY`}; nothing was called`,
      );
    }
    return writes === 0 ? 0 : 1;
  }
  const aws =
    options.aws ??
    readOnlyAws({
      region: options.region,
      ...(options.exceptions ? { exceptions: options.exceptions } : {}),
    });
  const results = await runChecks(checks, { aws });
  if (argv.includes("--json")) print(JSON.stringify(results, null, 2));
  else print(render(results));
  const failed = results.filter((r) => r.status === "FAIL").length;
  if (!argv.includes("--json")) print(`\n${failed === 0 ? "OK" : `${failed} FAILED`}`);
  return failed === 0 ? 0 : 1;
}
