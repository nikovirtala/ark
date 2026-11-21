/**
 * The helpers a project's smoke checks share, moved from longplay's `verify-platform.ts`: the
 * read-only AWS CLI runner, the not-found test, describing a stack, and `changedWithin` for the
 * first deploy of a scheduled job. What only longplay checks stays in longplay.
 */
import { execFileSync } from "node:child_process";
import type { Result, Status } from "./verdict.js";

/** Runs `aws <service> <command> ... --output json` and returns the parsed JSON (or undefined for no output). */
export type AwsRunner = (
  service: string,
  command: string,
  args?: readonly string[],
  region?: string,
) => unknown;

/**
 * Sub-commands that read without being named describe-/get-/list-: the STS identity and the two IAM
 * policy simulations (they evaluate a policy and change nothing). A project adds its own, each with
 * the reason it reads only (longplay adds `logs filter-log-events`, `dynamodb query` on its run
 * records and `verifiedpermissions is-authorized`).
 */
export const READ_ONLY_EXCEPTIONS: readonly string[] = [
  "sts get-caller-identity",
  "iam simulate-custom-policy",
  "iam simulate-principal-policy",
];

export function isReadOnlyCommand(
  service: string,
  command: string,
  exceptions: readonly string[] = READ_ONLY_EXCEPTIONS,
): boolean {
  if (exceptions.includes(`${service} ${command}`)) return true;
  return /^(describe|get|list)-/.test(command);
}

export interface ReadOnlyAwsOptions {
  readonly region: string;
  /** More sub-commands that only read, as `<service> <command>`. */
  readonly exceptions?: readonly string[];
  /** The environment of the CLI. Default: this process's. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * An AWS CLI runner that refuses any sub-command that is not describe-*, get-* or list-* (or a named
 * exception), so a check cannot change anything even when its role could.
 */
export function readOnlyAws(options: ReadOnlyAwsOptions): AwsRunner {
  const exceptions = [...READ_ONLY_EXCEPTIONS, ...(options.exceptions ?? [])];
  return (service, command, args = [], region = options.region) => {
    if (!isReadOnlyCommand(service, command, exceptions)) {
      throw new Error(`the smoke checks refuse a non-read-only call: aws ${service} ${command}`);
    }
    const out = execFileSync(
      "aws",
      [service, command, ...args, "--region", region, "--output", "json"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        ...(options.env ? { env: options.env as NodeJS.ProcessEnv } : {}),
      },
    );
    return out.trim().length > 0 ? JSON.parse(out) : undefined;
  };
}

/** True when the CLI error says the thing does not exist (so a check can FAIL cleanly instead of crashing). */
export function isNotFound(err: unknown): boolean {
  const text = String(
    (err as { stderr?: unknown; message?: unknown }).stderr ?? (err as Error).message ?? err,
  );
  return /does not exist|NotFound|not found|ResourceNotFoundException|NoSuchEntity|NotFoundException|ValidationError/i.test(
    text,
  );
}

export interface StackInfo {
  readonly status: string;
  readonly outputs: Record<string, string>;
  readonly tags: Record<string, string>;
  readonly lastUpdated: string | undefined;
}

/** A stack's status, outputs and tags, or undefined when it does not exist. */
export function describeStack(
  aws: AwsRunner,
  name: string,
  region?: string,
): StackInfo | undefined {
  try {
    const res = aws("cloudformation", "describe-stacks", ["--stack-name", name], region) as {
      Stacks: Array<{
        StackStatus: string;
        LastUpdatedTime?: string;
        CreationTime?: string;
        Outputs?: Array<{ OutputKey: string; OutputValue: string }>;
        Tags?: Array<{ Key: string; Value: string }>;
      }>;
    };
    const s = res.Stacks[0];
    if (!s) return undefined;
    return {
      status: s.StackStatus,
      outputs: Object.fromEntries((s.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue])),
      tags: Object.fromEntries((s.Tags ?? []).map((t) => [t.Key, t.Value])),
      lastUpdated: s.LastUpdatedTime ?? s.CreationTime,
    };
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

/** True for a stack status after a create or update that finished. */
export function isHealthyStackStatus(status: string): boolean {
  return /^(CREATE|UPDATE)_COMPLETE$/.test(status);
}

/**
 * True when the function's code or configuration changed less than `minutes` ago. A job that runs on
 * a schedule has not had its first run yet on the day it is first deployed, which is not a failure:
 * the first deploy of a task must pass the smoke checks before its tasks (and the schedule) have run.
 * Report INFO, never FAIL, while this holds.
 */
export function changedWithin(
  aws: AwsRunner,
  functionName: string,
  minutes: number,
  now: () => number = Date.now,
): boolean {
  try {
    const fn = aws("lambda", "get-function-configuration", ["--function-name", functionName]) as {
      LastModified?: string;
    };
    const at = Date.parse(String(fn.LastModified ?? "").replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
    return Number.isFinite(at) && now() - at < minutes * 60_000;
  } catch {
    return false;
  }
}

/** Orders task ids numerically: 1.10 after 1.9. */
export function taskOrder(task: string): number {
  const [major = "0", minor = "0"] = task.split(".");
  return Number(major) * 100 + Number(minor);
}

/** One line per result, as the checks print them without --json. */
export function render(results: readonly Result[]): string {
  return results
    .map((r) => `${r.status.padEnd(4)}  ${r.task}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`)
    .join("\n");
}

export type Add = (task: string, name: string, status: Status, detail?: string) => void;
