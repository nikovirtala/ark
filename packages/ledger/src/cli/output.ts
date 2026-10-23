import { createInterface } from "node:readline";

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
  /** Reads one line from stdin; `null` on EOF. Only used when `interactive`. */
  readonly readLine?: () => Promise<string | null>;
}

/**
 * Reads the first line of `input`, or `null` when it closes first, then closes the reader so the
 * process doesn't keep waiting on the stream.
 */
export function readLineFrom(input: NodeJS.ReadableStream): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input });
    let done = false;
    const finish = (line: string | null) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(line);
    };
    rl.once("line", (line) => finish(line));
    rl.once("close", () => finish(null));
  });
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
    readLine: () => readLineFrom(process.stdin),
  };
}
