import { type Edit, editorFromEnv } from "@nikovirtala/ledger/cli";

/**
 * The user's editor as the `edit` callback of `openIssue` and `editIssue`, or `null` when neither
 * `VISUAL` nor `EDITOR` is set (`editorFromEnv`).
 */
export function editorFor(
  env: NodeJS.ProcessEnv,
  o: { readonly stdoutIsTTY: boolean },
): Edit | null {
  return editorFromEnv(env, o);
}
