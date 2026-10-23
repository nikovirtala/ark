/** What a CLI run sees of its process; tests pass a fake. */
export interface CliIO {
  /** The arguments, without node and the script. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: { write(s: string): void };
  readonly stderr: { write(s: string): void };
  /** stdin and stdout are both TTYs. */
  readonly interactive: boolean;
  /** stdout is a TTY; when it isn't, a child such as an editor must not write to it. */
  readonly stdoutIsTTY: boolean;
}

/** The real process's arguments, directory, environment and streams. */
export function processIO(): CliIO {
  const stdoutIsTTY = process.stdout.isTTY === true;
  return {
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    stdout: { write: (s) => void process.stdout.write(s) },
    stderr: { write: (s) => void process.stderr.write(s) },
    interactive: process.stdin.isTTY === true && stdoutIsTTY,
    stdoutIsTTY,
  };
}
