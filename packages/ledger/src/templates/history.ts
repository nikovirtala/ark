import { RefNotFoundError } from "../errors.js";
import { type Finding, finding } from "../findings/finding.js";
import { assertPath, assertRev, catFileBatch, type Git } from "../git/git.js";
import type { TreeReader } from "../git/tree.js";
import { parseTemplate, type Template } from "./parse.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

function decode(bytes: Uint8Array): string | null {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Reads the current templates: every `*.md` file directly in `dir`, keyed by template name.
 * Files that don't parse are left out and reported in `findings`, as are lint findings.
 */
export async function loadTemplates(
  tree: TreeReader,
  dir: string,
): Promise<{ templates: Map<string, Template>; findings: Finding[] }> {
  const prefix = dir.replace(/\/+$/, "");
  const paths = (await tree.list(prefix))
    .filter((e) => e.type === "file" && e.path.endsWith(".md"))
    .map((e) => e.path)
    .filter((p) => !p.slice(prefix === "" ? 0 : prefix.length + 1).includes("/"));
  const blobs = await tree.readMany(paths);
  const templates = new Map<string, Template>();
  const findings: Finding[] = [];
  for (const path of paths) {
    const bytes = blobs.get(path);
    const text = bytes === undefined ? null : decode(bytes);
    if (text === null) {
      findings.push(
        finding({
          severity: "error",
          rule: "template/frontmatter",
          message: "template is not valid UTF-8",
          file: path,
        }),
      );
      continue;
    }
    const r = parseTemplate(text, { path });
    findings.push(...r.findings);
    if (r.ok && !templates.has(r.template.name)) templates.set(r.template.name, r.template);
  }
  return { templates, findings };
}

const versions = new WeakMap<Git, Map<string, Promise<Template | null>>>();

/**
 * The newest version of the template at `path` in the full history of `ref` (default `HEAD`)
 * whose `version` equals `version`, or `null`. Memoized per commit, path and version.
 */
export async function findTemplateVersion(
  git: Git,
  path: string,
  version: number,
  o: { readonly ref?: string } = {},
): Promise<Template | null> {
  const ref = o.ref ?? "HEAD";
  assertRev(ref);
  assertPath(path);
  const sha = await git.resolveCommit(ref);
  if (sha === null) throw new RefNotFoundError(ref);
  const cache = versions.get(git) ?? new Map<string, Promise<Template | null>>();
  versions.set(git, cache);
  const key = `${sha}\0${path}\0${version}`;
  let pending = cache.get(key);
  if (pending === undefined) {
    pending = search(git, sha, path, version);
    cache.set(key, pending);
    const settled = pending;
    settled.catch(() => {
      if (cache.get(key) === settled) cache.delete(key);
    });
  }
  return pending;
}

async function search(
  git: Git,
  sha: string,
  path: string,
  version: number,
): Promise<Template | null> {
  const r = await git.run([
    "--literal-pathspecs",
    "log",
    // Without --full-history, git drops a merge's side branch when the merge kept the other
    // side's file, and a version that only existed there would be missed.
    "--full-history",
    "--no-ext-diff",
    "--no-textconv",
    "--format=%H",
    "--end-of-options",
    sha,
    "--",
    path,
  ]);
  const commits = Buffer.from(r.stdout)
    .toString("utf8")
    .split("\n")
    .filter((l) => l !== "");
  const blobs = await catFileBatch(
    git,
    commits.map((c) => `${c}:${path}`),
  );
  for (const blob of blobs) {
    if (blob?.type !== "blob") continue;
    const text = decode(blob.bytes);
    if (text === null) continue;
    const parsed = parseTemplate(text, { path });
    if (parsed.ok && parsed.template.version === version) return parsed.template;
  }
  return null;
}
