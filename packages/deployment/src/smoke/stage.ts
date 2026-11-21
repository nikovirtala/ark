/**
 * The smoke stage of a run: optional commands before the checks (longplay's `record-test-run.ts`, as
 * its own narrow role), the project's check command with `--json` as the read-only smoke role, then
 * optional commands after them (longplay's `--deployed` policy simulations, each only when the
 * deployed commit has its task's marker output), then the verdict. A command that fails or a check
 * command that crashes is a failure, never an exception.
 */
import type { Env, Exec } from "../aws.js";
import { tail } from "../aws.js";
import { judge, parseResults, type Result, type SmokeVerdict } from "./verdict.js";

export interface SmokeCommand {
  /** What the log and a failure call it. */
  readonly name: string;
  /** The task it belongs to, for the failure line. */
  readonly task: string;
  readonly argv: readonly string[];
  /** The role it runs as: a key of `[roles]` (`smoke` when not set). */
  readonly role?: string;
  /** More variables for it. */
  readonly env?: Readonly<Record<string, string>>;
  /** Run only when the deployed template has this output. */
  readonly marker?: string;
}

export interface SmokeStageDeps {
  readonly exec: Exec;
  readonly repoRoot: string;
  /** The check command; `--json` is added. */
  readonly checks: readonly string[];
  readonly before?: readonly SmokeCommand[];
  readonly after?: readonly SmokeCommand[];
  readonly markers: Readonly<Record<string, string>>;
  readonly templateOutputs: ReadonlySet<string>;
  /** The environment of a role, by its key in `[roles]`. */
  readonly envFor: (role: string) => Env;
  /** More variables for the check command (the run gives it DEPLOY_COMMIT and DEPLOY_ENVIRONMENT). */
  readonly checksEnv?: Readonly<Record<string, string>>;
  readonly log: (message: string) => void;
}

function runCommand(deps: SmokeStageDeps, c: SmokeCommand): { ok: boolean; failure?: string } {
  if (c.marker !== undefined && !deps.templateOutputs.has(c.marker)) {
    deps.log(`INFO  ${c.task}  ${c.name} not run: the deployed commit has no ${c.marker}`);
    return { ok: true };
  }
  deps.log(`smoke: ${c.name}`);
  const [cmd, ...args] = c.argv;
  const r = deps.exec(cmd as string, args, {
    env: { ...deps.envFor(c.role ?? "smoke"), ...(c.env ?? {}) },
    cwd: deps.repoRoot,
  });
  const last = r.stdout.trim().split("\n").slice(-1)[0] ?? "";
  if (last) deps.log(last);
  if (r.status === 0) return { ok: true };
  return {
    ok: false,
    failure: `FAIL ${c.task} ${c.name} (exit ${String(r.status)}: ${tail(r.stdout + r.stderr, 3, " | ")})`,
  };
}

/** Runs the stage. Returns the verdict; a crash of any command is a failure, not an exception. */
export function runSmokeStage(deps: SmokeStageDeps): SmokeVerdict {
  for (const c of deps.before ?? []) {
    const r = runCommand(deps, c);
    if (!r.ok) return { ok: false, failures: [r.failure as string], counts: {} };
  }
  deps.log("smoke: the checks (read-only role)");
  const [cmd, ...args] = deps.checks;
  const out = deps.exec(cmd as string, [...args, "--json"], {
    env: { ...deps.envFor("smoke"), ...(deps.checksEnv ?? {}) },
    cwd: deps.repoRoot,
  });
  let results: Result[];
  try {
    results = parseResults(JSON.parse(out.stdout));
  } catch {
    return {
      ok: false,
      failures: [
        `FAIL the smoke checks printed nothing parseable (exit ${String(out.status)}: ${tail(out.stderr, 6, " | ")})`,
      ],
      counts: {},
    };
  }
  for (const r of results) {
    deps.log(`${r.status.padEnd(4)}  ${r.task}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  }
  const verdict = judge(results, deps.templateOutputs, deps.markers);
  const failures = [...verdict.failures];
  for (const c of deps.after ?? []) {
    const r = runCommand(deps, c);
    if (!r.ok) failures.push(r.failure as string);
  }
  // A check command exits 1 on a FAIL; a non-zero exit with no FAIL in the list means it crashed half way.
  if (out.status !== 0 && verdict.ok) {
    failures.unshift(
      `FAIL the smoke checks exited ${String(out.status)} with no FAIL in their list (${tail(out.stderr, 6, " | ")})`,
    );
  }
  return { ...verdict, ok: failures.length === 0, failures };
}
