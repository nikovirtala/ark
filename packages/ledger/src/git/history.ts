import { RefNotFoundError } from "../errors.js";
import { assertPath, assertRev, type Git, operationMemo, type Trailer } from "./git.js";

export interface CommitInfo {
  readonly sha: string;
  readonly parents: readonly string[];
  /** Strict ISO 8601. */
  readonly authorDate: string;
  readonly committerDate: string;
  readonly subject: string;
  readonly trailers: readonly Trailer[];
}

const TRAILER_LINE = /^([A-Za-z0-9][A-Za-z0-9-]*)[ \t]*:[ \t]*(.*)$/;

/** Parses `Key: value` lines, as printed by `%(trailers:only,unfold)`. Other lines are skipped. */
export function parseTrailerBlock(text: string): Trailer[] {
  const out: Trailer[] = [];
  for (const line of text.split("\n")) {
    const m = TRAILER_LINE.exec(line.trimEnd());
    if (m !== null) out.push([m[1] ?? "", (m[2] ?? "").trim()]);
  }
  return out;
}

async function resolveOrThrow(git: Git, ref: string): Promise<string> {
  assertRev(ref);
  const sha = await git.resolveCommit(ref);
  if (sha === null) throw new RefNotFoundError(ref);
  return sha;
}

/** The commits on the first-parent line of `ref`; commits reached only through merges are absent. */
export async function firstParentHistory(
  git: Git,
  ref: string,
  o: {
    readonly paths?: readonly string[];
    readonly order?: "newest-first" | "oldest-first";
    readonly since?: string;
  } = {},
): Promise<CommitInfo[]> {
  const sha = await resolveOrThrow(git, ref);
  const paths = o.paths ?? [];
  for (const p of paths) assertPath(p);
  const r = await git.run([
    "log",
    "--first-parent",
    "--no-ext-diff",
    "--no-textconv",
    "--format=%H%x1f%P%x1f%aI%x1f%cI%x1f%s%x1f%(trailers:only,unfold)%x1e",
    ...(o.order === "oldest-first" ? ["--reverse"] : []),
    ...(o.since === undefined ? [] : [`--since=${o.since}`]),
    "--end-of-options",
    sha,
    "--",
    ...paths,
  ]);
  const commits: CommitInfo[] = [];
  for (const record of Buffer.from(r.stdout).toString("utf8").split("\x1e")) {
    const fields = record.replace(/^\n/, "").split("\x1f");
    if (fields.length < 6) continue;
    const [hash = "", parents = "", authorDate = "", committerDate = "", subject = ""] = fields;
    commits.push({
      sha: hash,
      parents: parents === "" ? [] : parents.split(" "),
      authorDate,
      committerDate,
      subject,
      trailers: parseTrailerBlock(fields.slice(5).join("\x1f")),
    });
  }
  return commits;
}

/**
 * For each path under `prefix`, the first-parent commit that first added it, oldest first. A file
 * added on a merged branch is attributed to the merge commit. `o.not`: leave out the commits
 * these revisions reach, as `git log ^<rev>` does.
 */
export async function firstParentAdditions(
  git: Git,
  ref: string,
  prefix: string,
  o: { readonly not?: readonly string[] } = {},
): Promise<{ path: string; commit: string }[]> {
  const sha = await resolveOrThrow(git, ref);
  const not = await Promise.all((o.not ?? []).map((rev) => resolveOrThrow(git, rev)));
  assertPath(prefix);
  const p = prefix.replace(/\/+$/, "");
  const key = `first-parent-additions\0${sha}\0${p}\0${not.join("\0")}`;
  const additions = await operationMemo(git, key, async () => {
    const r = await git.run([
      "log",
      "--first-parent",
      "--reverse",
      "--diff-filter=A",
      "--name-only",
      "-z",
      "--no-ext-diff",
      "--no-textconv",
      "--format=%x1e%H",
      "--end-of-options",
      sha,
      ...not.map((n) => `^${n}`),
      "--",
      ...(p === "" ? [] : [p]),
    ]);
    const seen = new Set<string>();
    const out: { path: string; commit: string }[] = [];
    for (const record of Buffer.from(r.stdout).toString("utf8").split("\x1e")) {
      const [commit = "", ...names] = record.split("\0");
      if (commit === "") continue;
      for (const [i, raw] of names.entries()) {
        const path = i === 0 ? raw.replace(/^\n/, "") : raw;
        if (path === "" || seen.has(path)) continue;
        seen.add(path);
        out.push({ path, commit });
      }
    }
    return out;
  });
  // A git operation shares one result between callers: each gets its own copy.
  return additions.map((a) => ({ ...a }));
}
