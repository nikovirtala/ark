// A copy of adr/src/cli/editor.ts (adr may be imported only through @nikovirtala/adr/kind); lifting
// it into ledger/cli is a candidate for ark's step 5.
import { spawn } from "node:child_process";

/** The `edit` callback of `openIssue` and `editIssue`: `null` when the editor exited 0, else a note. */
export type Edit = (absPath: string) => Promise<string | null>;

/**
 * The user's editor as an `edit` callback, or `null` when neither `VISUAL` nor
 * `EDITOR` is set. The editor string is run by `sh -c` the way git runs `core.editor`, with the
 * path as the positional parameter `$1`, never interpolated. When stdout isn't a TTY (piped
 * `--json`, say), the editor's stdout goes to stderr so the CLI's stdout stays one document.
 * The callback never throws: a spawn error or a non-zero exit becomes the note.
 */
export function editorFor(
  env: NodeJS.ProcessEnv,
  o: { readonly stdoutIsTTY: boolean },
): Edit | null {
  const editor = [env.VISUAL, env.EDITOR].map((v) => v?.trim() ?? "").find((v) => v !== "");
  if (editor === undefined) return null;
  return (absPath) =>
    new Promise((resolve) => {
      const fail = (e: unknown) =>
        resolve(`could not start the editor: ${e instanceof Error ? e.message : String(e)}`);
      try {
        const child = spawn("sh", ["-c", `${editor} "$1"`, "sh", absPath], {
          env,
          stdio: o.stdoutIsTTY ? "inherit" : ["inherit", 2, "inherit"],
        });
        child.on("error", fail);
        child.on("close", (code, signal) => {
          if (code === 0) resolve(null);
          else {
            const how =
              code === null
                ? `was killed by ${signal ?? "a signal"}`
                : `exited with status ${code}`;
            resolve(`the editor ${how}`);
          }
        });
      } catch (e) {
        fail(e);
      }
    });
}
