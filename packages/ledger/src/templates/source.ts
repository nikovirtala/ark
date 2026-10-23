import type { Git } from "../git/git.js";
import type { TreeReader } from "../git/tree.js";
import { findTemplateVersion } from "./history.js";
import { parseTemplate, type Template } from "./parse.js";

export type TemplateLookup =
  | { readonly ok: true; readonly template: Template }
  | {
      readonly ok: false;
      /** `not-found`: no file `<dir>/<name>.md`; `version-not-found`: no file with that version. */
      readonly reason: "not-found" | "version-not-found";
      readonly path: string;
    };

/** Templates by name and version, for linting documents against the template they were made from. */
export interface TemplateSource {
  get(name: string, version: number): Promise<TemplateLookup>;
}

/** Builds a source for the head tree a check runs on; `dir` is repo-relative. */
export type TemplateSourceFactory = (head: TreeReader, dir: string) => TemplateSource;

const NAME = /^[a-z][a-z0-9-]*$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

/** The template parsed from `path` in `tree`; `null` for a missing, non-UTF-8 or invalid file. */
async function readTemplate(
  tree: TreeReader,
  path: string,
): Promise<{ exists: boolean; template: Template | null }> {
  const bytes = await tree.read(path);
  if (bytes === null) return { exists: false, template: null };
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return { exists: true, template: null };
  }
  const r = parseTemplate(text, { path });
  return { exists: true, template: r.ok ? r.template : null };
}

/** Memoizes `lookup` per `(name, version)`; names that can't be template names are not found. */
function memoized(
  dir: string,
  lookup: (name: string, version: number, path: string) => Promise<TemplateLookup>,
): TemplateSource {
  const prefix = dir.replace(/\/+$/, "");
  const cache = new Map<string, Promise<TemplateLookup>>();
  return {
    get(name, version) {
      const path = `${prefix}/${name}.md`;
      if (!NAME.test(name)) return Promise.resolve({ ok: false, reason: "not-found", path });
      const key = `${name}\0${version}`;
      let pending = cache.get(key);
      if (pending === undefined) {
        pending = lookup(name, version, path);
        cache.set(key, pending);
      }
      return pending;
    },
  };
}

/** Current versions in `dir` of `tree` only (tests, `MemoryTree`). */
export function treeTemplates(tree: TreeReader, dir: string): TemplateSource {
  return memoized(dir, async (_name, version, path) => {
    const current = await readTemplate(tree, path);
    if (current.template?.version === version) return { ok: true, template: current.template };
    return { ok: false, reason: current.exists ? "version-not-found" : "not-found", path };
  });
}

/**
 * The current version from `tree`, else the newest version with that number in the history of
 * `o.ref` (`findTemplateVersion`). `ref: null` (an unborn `HEAD`) skips the history lookup.
 */
export function historyTemplates(
  git: Git,
  tree: TreeReader,
  dir: string,
  o: { readonly ref: string | null },
): TemplateSource {
  return memoized(dir, async (_name, version, path) => {
    const current = await readTemplate(tree, path);
    if (current.template?.version === version) return { ok: true, template: current.template };
    const older =
      o.ref === null ? null : await findTemplateVersion(git, path, version, { ref: o.ref });
    if (older !== null) return { ok: true, template: older };
    return { ok: false, reason: current.exists ? "version-not-found" : "not-found", path };
  });
}

/** `(head, dir) => historyTemplates(git, head, dir, { ref: historyRef })`. */
export function gitTemplates(
  git: Git,
  o: { readonly historyRef: string | null },
): TemplateSourceFactory {
  return (head, dir) => historyTemplates(git, head, dir, { ref: o.historyRef });
}
