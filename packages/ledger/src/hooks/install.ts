import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { InvalidArgumentError } from "../errors.js";
import { type Git, requireWorkTree } from "../git/git.js";
import {
  assertRegistration,
  DEFAULT_HOOK_COMMANDS,
  HOOK_NAMES,
  type HookName,
  type HookRegistration,
  isHookName,
  parseShim,
  renderShim,
} from "./shim.js";

export interface HookInstallResult {
  /** Shims written or deleted. */
  readonly written: string[];
  readonly unchanged: string[];
  readonly conflicts: {
    readonly hook: HookName;
    readonly path: string;
    readonly reason: "foreign-hook" | "hooks-path";
  }[];
}

/** The hooks directory, absolute: `--git-path` is relative to the cwd for a work-tree `Git`. */
async function hooksDir(git: Git): Promise<string> {
  const r = await git.run(["rev-parse", "--git-path", "hooks"]);
  return resolve(git.root ?? git.gitDir, Buffer.from(r.stdout).toString("utf8").trim());
}

async function hooksPathSet(git: Git): Promise<boolean> {
  const r = await git.run(["config", "--get", "core.hooksPath"], { okCodes: [0, 1] });
  return r.code === 0;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function writeShim(path: string, text: string): Promise<void> {
  const tmp = `${path}.ark-${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, text, { mode: 0o755 });
  await chmod(tmp, 0o755);
  await rename(tmp, path);
}

interface ShimState {
  readonly hook: HookName;
  readonly path: string;
  readonly text: string | null;
  /** `null` for an absent file or a foreign hook. */
  readonly regs: HookRegistration[] | null;
}

async function readShims(dir: string): Promise<ShimState[]> {
  return Promise.all(
    HOOK_NAMES.map(async (hook) => {
      const path = join(dir, hook);
      const text = await readText(path);
      return { hook, path, text, regs: text === null ? null : parseShim(text, { path }) };
    }),
  );
}

/** Rewrites `s` with `regs`, deleting it when none remain. */
async function apply(s: ShimState, regs: readonly HookRegistration[], result: HookInstallResult) {
  if (regs.length === 0) {
    if (s.text !== null) {
      await rm(s.path, { force: true });
      result.written.push(s.path);
    }
    return;
  }
  const text = renderShim(s.hook, regs);
  if (text === s.text) {
    result.unchanged.push(s.path);
    return;
  }
  await writeShim(s.path, text);
  result.written.push(s.path);
}

/**
 * Sets `tool`'s registrations to exactly `commands` (default `DEFAULT_HOOK_COMMANDS`): added or
 * replaced for every hook listed, removed from every other hook. Other tools' registrations are
 * kept. A foreign hook file is never overwritten, and with `core.hooksPath` set nothing is written;
 * both come back as conflicts.
 */
export async function installHooks(
  git: Git,
  o: { readonly tool: string; readonly commands?: Partial<Record<HookName, readonly string[]>> },
): Promise<HookInstallResult> {
  requireWorkTree(git);
  const commands = o.commands ?? DEFAULT_HOOK_COMMANDS;
  const wanted = new Map<HookName, HookRegistration>();
  for (const [hook, argv] of Object.entries(commands)) {
    if (!isHookName(hook)) throw new InvalidArgumentError(`invalid hook: ${JSON.stringify(hook)}`);
    if (argv === undefined) continue;
    const reg = { tool: o.tool, hook, argv };
    assertRegistration(reg);
    wanted.set(hook, reg);
  }
  assertRegistration({ tool: o.tool, hook: "pre-commit", argv: [] });
  const result: HookInstallResult = { written: [], unchanged: [], conflicts: [] };
  const dir = await hooksDir(git);
  if (await hooksPathSet(git)) {
    for (const hook of HOOK_NAMES) {
      if (wanted.has(hook))
        result.conflicts.push({ hook, path: join(dir, hook), reason: "hooks-path" });
    }
    return result;
  }
  await mkdir(dir, { recursive: true });
  for (const s of await readShims(dir)) {
    const reg = wanted.get(s.hook);
    if (s.text !== null && s.regs === null) {
      if (reg !== undefined)
        result.conflicts.push({ hook: s.hook, path: s.path, reason: "foreign-hook" });
      continue;
    }
    const current = s.regs ?? [];
    if (reg === undefined && !current.some((r) => r.tool === o.tool)) continue;
    const others = current.filter((r) => r.tool !== o.tool);
    await apply(s, reg === undefined ? others : [...others, reg], result);
  }
  return result;
}

/** Removes `tool` from every shim, deleting shims left without registrations. */
export async function uninstallHooks(
  git: Git,
  o: { readonly tool: string },
): Promise<HookInstallResult> {
  assertRegistration({ tool: o.tool, hook: "pre-commit", argv: [] });
  const result: HookInstallResult = { written: [], unchanged: [], conflicts: [] };
  for (const s of await readShims(await hooksDir(git))) {
    if (s.regs === null || !s.regs.some((r) => r.tool === o.tool)) continue;
    await apply(
      s,
      s.regs.filter((r) => r.tool !== o.tool),
      result,
    );
  }
  return result;
}

/** Every registration in the repository's ark shims, by hook then tool. */
export async function readHookRegistry(git: Git): Promise<HookRegistration[]> {
  return (await readShims(await hooksDir(git))).flatMap((s) => s.regs ?? []);
}
