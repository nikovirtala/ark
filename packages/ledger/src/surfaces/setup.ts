import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Git } from "../git/git.js";
import { worktreeReader } from "../git/tree.js";
import { bodySha256 } from "../identity/hash.js";
import { writeNewFile } from "../log/write.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The committed record of what init last wrote, beside the configs at the repo root. */
export const SETUP_LOCK = "ark-setup.lock";

/**
 * A piece of the agent setup init owns and can rerun. A piece has a stable {@link id} (what the
 * lock keys on and what `--force <id>` names), the repo-relative {@link file} it lives in, and a
 * way to {@link render} the owned content from the file's current bytes (`null` when the file does
 * not exist). A `whole` piece owns the entire file; a `merge` piece owns named entries inside a
 * JSON object and leaves the rest alone, so two tools can share one file (e.g. `.mcp.json`).
 */
export interface SetupPiece {
  /** The piece's stable name: the lock key and what `--force <id>` names. */
  readonly id: string;
  /** The repo-relative file the piece lives in. */
  readonly file: string;
  /** Ownership: the whole file, or named entries merged into a JSON object. */
  readonly ownership: WholeOwnership | MergeOwnership;
}

/** The piece owns the entire file; its content is {@link WholeOwnership.text}. */
export interface WholeOwnership {
  readonly kind: "whole";
  /** The exact bytes the piece should hold. */
  readonly text: string;
}

/**
 * The piece owns the entries at `keys` (dotted paths into the JSON object, e.g. `mcpServers.adr`).
 * `entries` maps each key to its value; `scaffold` is the JSON the file gets when it must be
 * created from nothing, before the entries are merged in. The merge leaves every other key alone.
 */
export interface MergeOwnership {
  readonly kind: "merge";
  readonly scaffold: unknown;
  readonly entries: Readonly<Record<string, unknown>>;
  /**
   * Dotted paths whose final key is placed first in its parent object when newly added, so a
   * `scripts.prepare` entry lands at the front of `scripts` as the committed fixture has it.
   */
  readonly front?: readonly string[];
}

/** The lock's record for one piece: the hash of what init last wrote for it. */
interface LockEntry {
  readonly hash: string;
}

type LockFile = Record<string, LockEntry>;

/** What happened to one piece on a run. */
export interface PieceOutcome {
  readonly id: string;
  readonly file: string;
  /** `wrote` (new or updated), `kept` (unchanged), or `changed` (someone edited it; left alone). */
  readonly status: "wrote" | "kept" | "changed";
}

export interface SetupResult {
  readonly outcomes: readonly PieceOutcome[];
  /** Repo-relative files touched (written), in order, de-duplicated. */
  readonly written: readonly string[];
  readonly notes: readonly string[];
}

const JSON_WIDTH = 100;

/**
 * Formats `value` the way Biome formats JSON (2-space indent, line width 100): objects always
 * expand when non-empty, scalar arrays stay on one line when they fit, with `", "` and `": "`
 * separators. So init's JSON passes `biome check` and reproduces the committed fixtures exactly
 * (R9). It handles only JSON the setup writes (objects, arrays of scalars, scalars).
 */
function formatJson(value: unknown, indent = 0): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const pad = " ".repeat(indent);
  const padIn = " ".repeat(indent + 2);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const scalar = value.every((x) => x === null || typeof x !== "object");
    if (scalar) {
      const one = `[${value.map((x) => JSON.stringify(x)).join(", ")}]`;
      if (indent + one.length <= JSON_WIDTH) return one;
    }
    const items = value.map((x) => padIn + formatJson(x, indent + 2));
    return `[\n${items.join(",\n")}\n${pad}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 0) return "{}";
  const items = keys.map(
    (k) =>
      `${padIn}${JSON.stringify(k)}: ${formatJson((value as Record<string, unknown>)[k], indent + 2)}`,
  );
  return `{\n${items.join(",\n")}\n${pad}}`;
}

/** Biome-formatted JSON with a trailing newline, matching the committed fixtures. */
export function stringifyJson(value: unknown): string {
  return `${formatJson(value)}\n`;
}

/** Parses JSON bytes, or `null` when they are absent or not an object. */
function parseObject(bytes: Uint8Array | null): Record<string, unknown> | null {
  if (bytes === null) return null;
  try {
    const value = JSON.parse(decoder.decode(bytes)) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Sets the value at a dotted `path` in `obj`, creating intermediate objects as needed. */
function setPath(obj: Record<string, unknown>, path: string, value: unknown, front = false): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i] as string;
    const next = cur[key];
    if (typeof next !== "object" || next === null) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1] as string;
  if (front && !(last in cur)) {
    // Rebuild the parent with the new key first, matching the committed fixture's ordering.
    const rebuilt: Record<string, unknown> = { [last]: value };
    for (const [k, v] of Object.entries(cur)) rebuilt[k] = v;
    for (const k of Object.keys(cur)) delete cur[k];
    for (const [k, v] of Object.entries(rebuilt)) cur[k] = v;
  } else {
    cur[last] = value;
  }
}

/** Reads the value at a dotted `path` in `obj`, or `undefined`. */
function getPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const key of parts) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * The bytes a `merge` piece would write given the file's `current` bytes: the current object (or
 * the scaffold) with the owned entries set. The returned object is only the owned entries' view
 * used for the ownership hash; `full` is the whole file's new bytes.
 */
function mergedBytes(
  piece: SetupPiece & { readonly ownership: MergeOwnership },
  current: Uint8Array | null,
): { readonly full: string; readonly ownedHash: string } {
  const base = parseObject(current) ?? structuredClone(piece.ownership.scaffold);
  const obj = (typeof base === "object" && base !== null ? base : {}) as Record<string, unknown>;
  const front = new Set(piece.ownership.front ?? []);
  for (const [key, value] of Object.entries(piece.ownership.entries)) {
    setPath(obj, key, value, front.has(key));
  }
  // The ownership hash covers only the owned entries, so another server in the same file never
  // makes init think someone edited the piece.
  const owned = Object.fromEntries(
    Object.entries(piece.ownership.entries).map(([key]) => [key, getPath(obj, key)]),
  );
  return { full: stringifyJson(obj), ownedHash: bodySha256(encoder.encode(stringifyJson(owned))) };
}

/** The hash of what a `merge` piece currently owns in `current`, or `null` when none is present. */
function ownedHashOf(
  piece: SetupPiece & { readonly ownership: MergeOwnership },
  current: Uint8Array | null,
): string | null {
  const obj = parseObject(current);
  if (obj === null) return null;
  const present = Object.keys(piece.ownership.entries).some((k) => getPath(obj, k) !== undefined);
  if (!present) return null;
  const owned = Object.fromEntries(
    Object.entries(piece.ownership.entries).map(([key]) => [key, getPath(obj, key)]),
  );
  return bodySha256(encoder.encode(stringifyJson(owned)));
}

/** Reads a lock file's JSON, tolerating a missing or malformed file. */
function parseLock(bytes: Uint8Array | null): LockFile {
  const obj = parseObject(bytes);
  if (obj === null) return {};
  const out: LockFile = {};
  for (const [id, entry] of Object.entries(obj)) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as LockEntry).hash === "string"
    ) {
      out[id] = { hash: (entry as LockEntry).hash };
    }
  }
  return out;
}

/** The per-clone lock path under the git common dir: `<common>/ark/setup.json`. */
function cloneLockPath(git: Git): string {
  return join(git.commonDir, "ark", "setup.json");
}

export interface ApplySetupOptions {
  /** Pieces to opt out of, by id; the piece is skipped entirely. */
  readonly skip?: ReadonlySet<string>;
  /** Pieces to force-overwrite even when someone changed them, by id. */
  readonly force?: ReadonlySet<string>;
  /** The note a changed piece prints; `tool` names the overwrite command `<tool> init --force`. */
  readonly tool: string;
}

/**
 * Applies the setup pieces, owning only what init wrote (R2, R3). For each piece: the hash it
 * last wrote is read from the committed {@link SETUP_LOCK} (falling back to the per-clone lock).
 * If the piece is missing it is written; if what is there matches the last-written hash (or the
 * piece's own new content) it is replaced with the new version; if it was changed by someone it is
 * left alone with a note naming the file and `<tool> init --force <id>`, unless `force` lists it. A
 * run that changes nothing leaves the working tree and both locks untouched. The committed lock and
 * the per-clone lock are themselves pieces of the working tree: the committed lock is written
 * through `writeFiles` and staged with the rest; the per-clone lock is written outside the repo.
 */
export async function applySetup(
  git: Git,
  pieces: readonly SetupPiece[],
  o: ApplySetupOptions,
): Promise<SetupResult> {
  const reader = worktreeReader(git);
  const committedLock = parseLock(await reader.read(SETUP_LOCK));
  const cloneLock = parseLock(await readClone(git));
  const lastHash = (id: string): string | null =>
    committedLock[id]?.hash ?? cloneLock[id]?.hash ?? null;

  const outcomes: PieceOutcome[] = [];
  const notes: string[] = [];
  // Each file's planned new bytes, so two pieces sharing one file compose, and the lock update.
  const planned = new Map<string, string>();
  const nextLock: LockFile = { ...committedLock };

  for (const piece of pieces) {
    if (o.skip?.has(piece.id) === true) continue;
    const pending = planned.get(piece.file);
    const currentBytes =
      pending !== undefined ? encoder.encode(pending) : await reader.read(piece.file);
    const forced = o.force?.has(piece.id) === true;

    if (piece.ownership.kind === "whole") {
      const target = piece.ownership.text;
      const targetHash = bodySha256(encoder.encode(target));
      const have = currentBytes === null ? null : decoder.decode(currentBytes);
      const haveHash = have === null ? null : bodySha256(currentBytes as Uint8Array);
      if (have === null) {
        planned.set(piece.file, target);
        nextLock[piece.id] = { hash: targetHash };
        outcomes.push({ id: piece.id, file: piece.file, status: "wrote" });
      } else if (haveHash === targetHash) {
        nextLock[piece.id] = { hash: targetHash };
        outcomes.push({ id: piece.id, file: piece.file, status: "kept" });
      } else if (forced || haveHash === lastHash(piece.id)) {
        planned.set(piece.file, target);
        nextLock[piece.id] = { hash: targetHash };
        outcomes.push({ id: piece.id, file: piece.file, status: "wrote" });
      } else {
        notes.push(changedNote(piece, o.tool));
        outcomes.push({ id: piece.id, file: piece.file, status: "changed" });
      }
    } else {
      const merged = mergedBytes(piece as SetupPiece & { ownership: MergeOwnership }, currentBytes);
      const currentOwned = ownedHashOf(
        piece as SetupPiece & { ownership: MergeOwnership },
        currentBytes,
      );
      if (currentOwned === null) {
        planned.set(piece.file, merged.full);
        nextLock[piece.id] = { hash: merged.ownedHash };
        outcomes.push({ id: piece.id, file: piece.file, status: "wrote" });
      } else if (currentOwned === merged.ownedHash) {
        nextLock[piece.id] = { hash: merged.ownedHash };
        outcomes.push({ id: piece.id, file: piece.file, status: "kept" });
      } else if (forced || currentOwned === lastHash(piece.id)) {
        planned.set(piece.file, merged.full);
        nextLock[piece.id] = { hash: merged.ownedHash };
        outcomes.push({ id: piece.id, file: piece.file, status: "wrote" });
      } else {
        notes.push(changedNote(piece, o.tool));
        outcomes.push({ id: piece.id, file: piece.file, status: "changed" });
      }
    }
  }

  // The committed lock reflects every piece this run owns (written or kept); it only changes when
  // a hash changed, so a no-op rerun leaves it byte-identical and the working tree unchanged.
  const lockText = stringifyJson(sortKeys(nextLock));
  const lockChanged =
    decoder.decode((await reader.read(SETUP_LOCK)) ?? new Uint8Array()) !== lockText;
  if (lockChanged && planned.size > 0) planned.set(SETUP_LOCK, lockText);

  const written: string[] = [];
  for (const [file, text] of planned) {
    await writeFile(git, file, text);
    written.push(file);
  }
  // The per-clone lock mirrors the committed one; written only when something was written.
  if (written.length > 0) await writeClone(git, lockText);

  return { outcomes, written, notes };
}

/** The note a changed piece prints (R2): names the file and the overwrite command. */
function changedNote(piece: SetupPiece, tool: string): string {
  return `${piece.file} was changed since init wrote it, so it is left as it is; run ${tool} init --force ${piece.id} to overwrite it`;
}

/** Sorts an object's keys, for a stable committed lock. */
function sortKeys(obj: LockFile): LockFile {
  const out: LockFile = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key] as LockEntry;
  return out;
}

/** Writes a repo file, replacing it if present (setup pieces own their content). */
async function writeFile(git: Git, path: string, text: string): Promise<void> {
  const full = join(git.root ?? "", path);
  await rm(full, { force: true });
  await writeNewFile(git, path, encoder.encode(text));
}

async function readClone(git: Git): Promise<Uint8Array | null> {
  const { readFile } = await import("node:fs/promises");
  return readFile(cloneLockPath(git)).catch(() => null);
}

async function writeClone(git: Git, text: string): Promise<void> {
  const { mkdir, writeFile: write } = await import("node:fs/promises");
  const path = cloneLockPath(git);
  await mkdir(join(git.commonDir, "ark"), { recursive: true });
  await write(path, encoder.encode(text));
}

/**
 * What one piece looks like in the working tree compared with what the installed tool would write,
 * for `doctor`. `present` is whether the piece's owned content is there at all; `matchesTarget` is
 * whether what is there equals what the installed tool would write (the piece's target); `changed`
 * is whether what is there differs from the hash init last wrote (from the lock) — the difference
 * between "someone edited it" and "init wrote it with an older tool". `version`/`targetVersion`
 * are the exact versions an MCP piece points at now and would point at, so doctor can report a pin
 * that names a version other than the installed one.
 */
export interface PieceState {
  readonly id: string;
  readonly file: string;
  readonly present: boolean;
  readonly matchesTarget: boolean;
  readonly changed: boolean;
  readonly version: string | null;
  readonly targetVersion: string | null;
}

/** The last-written hash lookup both locks provide, committed taking precedence over per-clone. */
async function lastHashes(git: Git): Promise<(id: string) => string | null> {
  const reader = worktreeReader(git);
  const committed = parseLock(await reader.read(SETUP_LOCK));
  const clone = parseLock(await readClone(git));
  return (id) => committed[id]?.hash ?? clone[id]?.hash ?? null;
}

/** The first `pkg@x.y.z` version found in a merge piece's owned entries, or `null`. */
function versionIn(value: unknown): string | null {
  const json = JSON.stringify(value);
  const m = /@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(json);
  return m?.[1] ?? null;
}

/**
 * The {@link PieceState} of each piece against the working tree (R5): what the installed tool
 * reports for `doctor`. It never writes anything. For a `whole` piece the target is its bytes; for
 * a `merge` piece the target is its owned entries' hash, so another server in the same file is
 * ignored. `changed` compares what is there against the committed/per-clone lock.
 */
export async function pieceStates(
  git: Git,
  pieces: readonly SetupPiece[],
): Promise<readonly PieceState[]> {
  const reader = worktreeReader(git);
  const lastHash = await lastHashes(git);
  const states: PieceState[] = [];
  for (const piece of pieces) {
    const current = await reader.read(piece.file);
    if (piece.ownership.kind === "whole") {
      const target = piece.ownership.text;
      const targetHash = bodySha256(encoder.encode(target));
      const have = current === null ? null : decoder.decode(current);
      const haveHash = current === null ? null : bodySha256(current);
      states.push({
        id: piece.id,
        file: piece.file,
        present: have !== null,
        matchesTarget: haveHash === targetHash,
        changed: haveHash !== null && haveHash !== targetHash && haveHash !== lastHash(piece.id),
        version: null,
        targetVersion: null,
      });
    } else {
      const merge = piece as SetupPiece & { ownership: MergeOwnership };
      const merged = mergedBytes(merge, current);
      const currentOwned = ownedHashOf(merge, current);
      const obj = parseObject(current);
      // Only the first owned entry is version-checked. Every current MCP piece owns a single
      // entry; a merge piece that ever owns two versioned entries would need this generalized.
      const entryKey = Object.keys(merge.ownership.entries)[0];
      const currentValue =
        obj === null || entryKey === undefined ? undefined : getPath(obj, entryKey);
      states.push({
        id: piece.id,
        file: piece.file,
        present: currentOwned !== null,
        matchesTarget: currentOwned === merged.ownedHash,
        changed:
          currentOwned !== null &&
          currentOwned !== merged.ownedHash &&
          currentOwned !== lastHash(piece.id),
        version: currentValue === undefined ? null : versionIn(currentValue),
        targetVersion: entryKey === undefined ? null : versionIn(merge.ownership.entries[entryKey]),
      });
    }
  }
  return states;
}
