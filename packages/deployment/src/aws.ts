/**
 * The AWS CLI as the pipeline's one way out of the process for STS, SNS, CloudFormation and
 * CloudWatch, as in longplay: a project's smoke checks already use the CLI, so the build needs no
 * more SDK clients than the ledger's and the freeze flag's. Credentials travel in the environment of
 * the child process: a role is assumed once, and its keys are given to the step that is meant to use
 * that role and to no other.
 */
import { spawnSync } from "node:child_process";

export type Env = Readonly<Record<string, string | undefined>>;

export interface ExecResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecOptions {
  readonly env: Env;
  readonly cwd?: string;
  readonly input?: string;
  /** Stream the output to this process's (for the long commands: cdk deploy, the checks). */
  readonly stream?: boolean;
}

/** Runs a command. A seam for tests; the default is `spawnSync`. */
export type Exec = (command: string, args: readonly string[], options: ExecOptions) => ExecResult;

export const defaultExec: Exec = (command, args, options) => {
  const r = spawnSync(command, [...args], {
    env: options.env as NodeJS.ProcessEnv,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.input !== undefined ? { input: options.input } : {}),
    stdio: options.stream ? ["ignore", "inherit", "inherit"] : ["pipe", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? (r.error ? String(r.error) : ""),
  };
};

const CREDENTIAL_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
];

/** The process environment without the build's own credentials, so a child uses exactly the keys it is given. */
export function withoutCredentials(env: Env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const k of CREDENTIAL_KEYS) delete out[k];
  return out;
}

/** The last few lines of a command's error, on one line: what a failure says without its whole log. */
export function tail(text: string, lines = 3, separator = " "): string {
  return text.trim().split("\n").slice(-lines).join(separator);
}

export class Aws {
  private readonly exec: Exec;
  private readonly base: Env;
  readonly region: string;

  constructor(region: string, exec: Exec = defaultExec, base: Env = process.env) {
    this.region = region;
    this.exec = exec;
    this.base = base;
  }

  /** `aws <args> --region <region> --output json`, parsed. Throws with the CLI's own message on failure. */
  json(args: readonly string[], env: Env = this.base): unknown {
    const r = this.exec("aws", [...args, "--region", this.region, "--output", "json"], { env });
    if (r.status !== 0) {
      throw new Error(`aws ${args.slice(0, 2).join(" ")} failed: ${tail(r.stderr)}`);
    }
    return r.stdout.trim().length > 0 ? JSON.parse(r.stdout) : undefined;
  }

  accountId(env: Env = this.base): string {
    return (this.json(["sts", "get-caller-identity"], env) as { Account: string }).Account;
  }

  /** The environment of a child that is to act as `roleName`: its temporary keys in place of everything else. */
  assume(
    roleName: string,
    session: string,
    durationSeconds = 3600,
  ): Record<string, string | undefined> {
    const arn = `arn:aws:iam::${this.accountId()}:role/${roleName}`;
    const out = this.json([
      "sts",
      "assume-role",
      "--role-arn",
      arn,
      "--role-session-name",
      session.replace(/[^\w+=,.@-]/g, "-").slice(0, 64),
      "--duration-seconds",
      String(durationSeconds),
    ]) as { Credentials: { AccessKeyId: string; SecretAccessKey: string; SessionToken: string } };
    return {
      ...withoutCredentials(this.base),
      AWS_ACCESS_KEY_ID: out.Credentials.AccessKeyId,
      AWS_SECRET_ACCESS_KEY: out.Credentials.SecretAccessKey,
      AWS_SESSION_TOKEN: out.Credentials.SessionToken,
      AWS_REGION: this.region,
      AWS_DEFAULT_REGION: this.region,
    };
  }

  /** The outputs of a stack, by key. */
  stackOutputs(stack: string, env: Env = this.base): Record<string, string> {
    const res = this.json(["cloudformation", "describe-stacks", "--stack-name", stack], env) as {
      Stacks: Array<{ Outputs?: Array<{ OutputKey: string; OutputValue: string }> }>;
    };
    return Object.fromEntries(
      (res.Stacks[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]),
    );
  }
}
