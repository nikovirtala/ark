import { type Edit, editorFromEnv } from "@nikovirtala/ledger/cli";

/**
 * The user's editor as `proposeDecision`'s `edit` callback (design §5.7), or `null` when neither
 * `VISUAL` nor `EDITOR` is set (`editorFromEnv`). A failure note ends with "; the draft is staged
 * as rendered".
 */
export function editorFor(
  env: NodeJS.ProcessEnv,
  o: { readonly stdoutIsTTY: boolean },
): Edit | null {
  return editorFromEnv(env, { ...o, failureSuffix: "; the draft is staged as rendered" });
}
