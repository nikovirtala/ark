import type { CliIO } from "./output.js";

/**
 * Asks a yes/no `question` on stderr and reads the answer from stdin; `true` only for `y` or
 * `yes` (any case, surrounding spaces ignored). Never asks, and returns `false`, under `--json`,
 * without a terminal on stdin and stdout (scripts, CI, hooks run with `</dev/null`) or when the
 * IO can't read a line.
 */
export async function confirm(
  io: CliIO,
  question: string,
  o: { readonly json: boolean },
): Promise<boolean> {
  if (o.json || !io.interactive || io.readLine === undefined) return false;
  io.stderr.write(question);
  const answer = await io.readLine();
  return answer !== null && /^(?:y|yes)$/i.test(answer.trim());
}
