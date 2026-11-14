import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ConfiguredHook,
  HarnessRuntime,
  HookResult,
  HookScenario,
  RepoFiles,
} from "../surfaces/harness-runtime.js";

/**
 * Helpers for tests that run the generated agent setup the way each harness does (?81): the
 * configured command string, through the harness's shell, from the directory the harness uses,
 * with its documented event on stdin. Used by ledger's own conformance suite and by the adr and
 * issues packages, which start their MCP servers the way each harness would.
 */

/** The files of the repository at `root`, for a harness runtime's config readers. */
export function repoFiles(root: string): RepoFiles {
  return {
    read(path) {
      try {
        return readFileSync(join(root, path), "utf8");
      } catch {
        return null;
      }
    },
    list(dir) {
      try {
        return readdirSync(join(root, dir))
          .sort()
          .map((f) => `${dir}/${f}`);
      } catch {
        return [];
      }
    },
  };
}

/** Stand-ins for `npm` and the tools, so a hook runs without the network. */
export interface ToolStubs {
  /** A directory to put first on `PATH`. */
  readonly bin: string;
  /** Every stubbed command's arguments, one line per call: `<command> <args…>`. */
  readonly log: string;
  /** The text of the log. */
  calls(): string[];
}

/**
 * Writes stubs for `npm exec`, `npx`, `adr` and `issues` into a fresh directory. `npm exec … -- cmd`
 * and `npx -y pkg@ver args` run the stubbed tool; `adr for <path>` reports a decision for paths
 * under `src/` and "no decisions" elsewhere; `issues for` always reports "no issues".
 */
export function installToolStubs(): ToolStubs {
  const dir = mkdtempSync(join(tmpdir(), "ledger-stubs-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  script(
    "npm",
    `[ "$1" = exec ] || exit 1
shift
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    *) shift ;;
  esac
done
exec "$@"`,
  );
  script(
    "npx",
    `if [ "$1" = -y ]; then shift; fi
pkg="$1"
shift
tool="\${pkg#@nikovirtala/}"
tool="\${tool%@*}"
exec "$tool" "$@"`,
  );
  script(
    "adr",
    `echo "adr $*" >> "$STUB_LOG"
case "$1" in
  for)
    case "$2" in
      src/*) printf '%s\\n  ADR-0001 (aaaa1111)  accepted    Keep the store behind one module  glob src/**\\n' "$2" ;;
      *) printf '%s\\n  no decisions\\n' "$2" ;;
    esac ;;
  list) echo "ADR-0002 (bbbb2222)  proposed    Cache sessions" ;;
esac
exit 0`,
  );
  script(
    "issues",
    `echo "issues $*" >> "$STUB_LOG"
case "$1" in
  for) printf '%s\\n  no issues\\n' "$2" ;;
  list) echo "?2  open  Fix the cache" ;;
  ready) echo "?1  open  Write the store" ;;
esac
exit 0`,
  );
  return {
    bin,
    log,
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l !== ""),
  };
}

/** What running one hook the way its harness would left behind. */
export interface HookRun {
  readonly result: HookResult;
  /** Wall-clock milliseconds the hook took. */
  readonly ms: number;
  /** The argument string the harness passed its shell. */
  readonly command: string;
}

/**
 * Runs `hook` for `scenario` as its harness does: `runtime.shell -c <command>` from the directory
 * and with the environment and stdin `runtime.invocation` declares. `cwd` is the directory the
 * session was started from, for harnesses that use it (default: the repository root). The stubs'
 * directory is put first on `PATH`.
 */
export function runHook(o: {
  readonly runtime: HarnessRuntime;
  readonly root: string;
  readonly hook: ConfiguredHook;
  readonly scenario: HookScenario;
  readonly stubs: ToolStubs;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}): HookRun {
  const inv = o.runtime.invocation({
    root: o.root,
    cwd: o.cwd ?? o.root,
    scenario: o.scenario,
  });
  const start = performance.now();
  const r = spawnSync(o.runtime.shell, ["-c", o.hook.command], {
    cwd: inv.cwd,
    input: inv.stdin,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${o.stubs.bin}:${process.env.PATH ?? ""}`,
      STUB_LOG: o.stubs.log,
      HOME: o.root,
      // The hook runs from this repository, never an outer one.
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      ...o.env,
      ...inv.env,
    },
  });
  return {
    ms: performance.now() - start,
    command: o.hook.command,
    result: { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" },
  };
}
