import { HOOK_NAMES, type HookName } from "./shim.js";

/** A tool's command for one hook, as a tool's `hooks … --json` lists it. */
export interface ToolHookRegistration {
  readonly hook: HookName;
  readonly argv: readonly string[];
}

/**
 * The registrations of a tool's command map, one per hook it has a command for, in hook order:
 * pre-commit, commit-msg, pre-push, post-merge (`HOOK_NAMES`).
 */
export function hookRegistrations(
  commands: Partial<Record<HookName, readonly string[]>>,
): ToolHookRegistration[] {
  return HOOK_NAMES.flatMap((hook) => {
    const argv = commands[hook];
    return argv === undefined ? [] : [{ hook, argv }];
  });
}
