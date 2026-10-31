import { relative, sep } from "node:path";
import type { Git, Trailer } from "../git/git.js";
import {
  assertNoHookConflicts,
  type HookInstallResult,
  installHooks,
  uninstallHooks,
} from "../hooks/install.js";
import { hookRegistrations, type ToolHookRegistration } from "../hooks/registrations.js";
import { HOOK_NAMES, type HookName } from "../hooks/shim.js";
import { type HookManager, hookSnippet } from "../hooks/snippets.js";
import type { ToolLog } from "./tool-log.js";

/** `<tool> hooks … --json`, such as `adr-hooks/v1`; `hooks run` prints `ledger-findings/v1`. */
export interface ToolHooksJson<F extends string = string> {
  readonly format: F;
  readonly action: "install" | "uninstall" | "print" | "trailers";
  /** Repo-relative shim paths written or removed. */
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  readonly registrations: readonly ToolHookRegistration[];
  /** `print` only. */
  readonly snippet: string | null;
  /** `trailers` only: the trailers added, in order. */
  readonly trailers: readonly (readonly [string, string])[];
}

/** Which tool's hooks: its name and its JSON `format`. */
export interface ToolHooksSpec<F extends string = string> {
  readonly tool: string;
  readonly format: F;
}

/**
 * A tool's command per hook (design 2b D4), after `<tool>`. `--root <root>` comes first only when
 * the root can't be found without it: no `<repo>/<tool>.toml` names it and it isn't the kind's
 * default root. So the hooks see the same config as a plain `<tool>` run, and never print the
 * root-override note.
 */
export function toolHookCommands(
  log: ToolLog,
  tool: string,
): Partial<Record<HookName, readonly string[]>> {
  const r =
    log.configPath === `${tool}.toml` || log.layout.root === log.kind.def.defaultRoot
      ? []
      : ["--root", log.layout.root];
  return {
    "pre-commit": [...r, "hooks", "run", "pre-commit"],
    "commit-msg": [...r, "hooks", "trailers", "{args}"],
    "pre-push": [...r, "verify", "--base", "@{upstream}", "--ref", "HEAD", "--fetch-sources"],
    "post-merge": [...r, "list", "--since", "ORIG_HEAD"],
  };
}

/** A shim path as the user sees it: repo-relative, with `/`. */
function shown(git: Git, path: string): string {
  return relative(git.root ?? git.gitDir, path)
    .split(sep)
    .join("/");
}

/** The shims in hook order, as the text output lists them. */
function inHookOrder(git: Git, paths: readonly string[]): string[] {
  const rank = (p: string) => HOOK_NAMES.findIndex((h) => p.endsWith(`/${h}`));
  return paths.map((p) => shown(git, p)).sort((a, b) => rank(a) - rank(b));
}

/**
 * The `<tool> hooks … --json` document of `action`: the shims `r` wrote and left unchanged (none
 * without `r`), the tool's registrations (`toolHookCommands`), and `extra`'s snippet and trailers.
 */
export function toolHooksResult<F extends string>(
  log: ToolLog,
  spec: ToolHooksSpec<F>,
  action: ToolHooksJson["action"],
  r: HookInstallResult | null,
  extra: { readonly snippet?: string; readonly trailers?: readonly Trailer[] } = {},
): ToolHooksJson<F> {
  return {
    format: spec.format,
    action,
    written: r === null ? [] : inHookOrder(log.git, r.written),
    unchanged: r === null ? [] : inHookOrder(log.git, r.unchanged),
    registrations: hookRegistrations(toolHookCommands(log, spec.tool)),
    snippet: extra.snippet ?? null,
    trailers: extra.trailers ?? [],
  };
}

/**
 * Registers the tool's commands in ledger's shims, one per hook and shared with other ark tools
 * (design 2b D4). With `core.hooksPath` set or a foreign hook file present, it writes the rest and
 * then throws `HookConflictError` (exit 2), naming each conflict and the `print` command.
 */
export async function installToolHooks<F extends string>(
  log: ToolLog,
  spec: ToolHooksSpec<F>,
): Promise<ToolHooksJson<F>> {
  const r = await installHooks(log.git, {
    tool: spec.tool,
    commands: toolHookCommands(log, spec.tool),
  });
  assertNoHookConflicts(r, { tool: spec.tool });
  return toolHooksResult(log, spec, "install", r);
}

/** Removes the tool from every shim; a shim left with no tool is deleted. */
export async function uninstallToolHooks<F extends string>(
  log: ToolLog,
  spec: ToolHooksSpec<F>,
): Promise<ToolHooksJson<F>> {
  return toolHooksResult(
    log,
    spec,
    "uninstall",
    await uninstallHooks(log.git, { tool: spec.tool }),
  );
}

/** The config to paste into a hook manager instead of installing shims. */
export function printToolHooks<F extends string>(
  log: ToolLog,
  spec: ToolHooksSpec<F>,
  manager: HookManager,
): ToolHooksJson<F> {
  const regs = hookRegistrations(toolHookCommands(log, spec.tool)).map((r) => ({
    tool: spec.tool,
    ...r,
  }));
  return toolHooksResult(log, spec, "print", null, { snippet: hookSnippet(manager, regs) });
}
