/**
 * Comment anchors (design §3.3, D-f): `<keyword>:<id>` or `<keyword>:<source>:<id>` in a code
 * comment, for example `// adr:<id>` or `# adr:platform:k3f9q8a1`. A token counts only when a
 * comment leader comes earlier on its line; the rule is a heuristic.
 */
import { InvalidArgumentError } from "../errors.js";
import { assertPath, assertRev, type Git, requireWorkTree } from "../git/git.js";
import { globMatcher, parseGlob } from "./glob.js";

export interface Anchor {
  /** Repo-relative. */
  readonly path: string;
  /** 1-based. */
  readonly line: number;
  /** `"platform"` in a qualified anchor; `null` for the local log. */
  readonly source: string | null;
  /** The 8-character subject id. */
  readonly id: string;
}

const KEYWORD = /^[a-z][a-z0-9-]{0,31}$/;
const LEADERS = ["//", "/*", "#", "--", ";", "%", "<!--", "(*"] as const;
const ID_CHAR = /[0-9a-hjkmnp-tv-z]/;
const SOURCE_FIRST = /[a-z]/;
const SOURCE_CHAR = /[a-z0-9-]/;
/** Characters that may not come right before a token. */
const BLOCKED_BEFORE = /[A-Za-z0-9_.:/-]/;
/** Characters that may not come right after a token. */
const BLOCKED_AFTER = /[A-Za-z0-9_-]/;
const ALNUM = /[A-Za-z0-9]/;
const WHITESPACE = /\s/;

const at = (s: string, i: number) => s.charAt(i);

/** 8 id characters at `i`; their end, or -1. */
function idAt(text: string, i: number): number {
  for (let k = 0; k < 8; k++) if (!ID_CHAR.test(at(text, i + k))) return -1;
  return i + 8;
}

/** Whether the token may end at `end`: no word character and no `:` plus alphanumeric next. */
function endsCleanly(text: string, end: number): boolean {
  if (text.startsWith("-->", end)) return true;
  const next = at(text, end);
  if (next !== "" && BLOCKED_AFTER.test(next)) return false;
  return !(next === ":" && ALNUM.test(at(text, end + 1)));
}

/** A `<source>:` at `i`; the index after the `:`, or -1. */
function sourceAt(text: string, i: number): number {
  if (!SOURCE_FIRST.test(at(text, i))) return -1;
  let j = i + 1;
  while (j - i < 32 && SOURCE_CHAR.test(at(text, j))) j++;
  return at(text, j) === ":" ? j + 1 : -1;
}

/** Pure: the anchors on one line of text (D-f); `column` is the 1-based start of the token. */
export function anchorsInLine(
  text: string,
  keyword: string,
): { source: string | null; id: string; column: number }[] {
  const out: { source: string | null; id: string; column: number }[] = [];
  const head = `${keyword}:`;
  // Where each leader occurrence ends, and whether it may sit right before a token.
  const leaderEnds: { end: number; standalone: boolean }[] = [];
  for (const l of LEADERS) {
    for (let i = text.indexOf(l); i !== -1; i = text.indexOf(l, i + 1)) {
      const before = at(text, i - 1);
      const standalone = text.slice(0, i).trim() === "" || WHITESPACE.test(before);
      leaderEnds.push({ end: i + l.length, standalone });
    }
  }
  const firstLeaderEnd = Math.min(...leaderEnds.map((l) => l.end), Number.POSITIVE_INFINITY);
  const star = text.trimStart().startsWith("*") ? text.indexOf("*") + 1 : Number.POSITIVE_INFINITY;
  const commentStart = Math.min(firstLeaderEnd, star);

  for (let p = text.indexOf(head); p !== -1; p = text.indexOf(head, p + 1)) {
    if (p < commentStart) continue;
    const before = at(text, p - 1);
    if (before !== "" && BLOCKED_BEFORE.test(before)) {
      if (!leaderEnds.some((l) => l.end === p && l.standalone)) continue;
    }
    const rest = p + head.length;
    let end = -1;
    let source: string | null = null;
    const afterSource = sourceAt(text, rest);
    if (afterSource !== -1) {
      const idEnd = idAt(text, afterSource);
      if (idEnd !== -1 && endsCleanly(text, idEnd)) {
        source = text.slice(rest, afterSource - 1);
        end = idEnd;
      }
    }
    if (end === -1) {
      const idEnd = idAt(text, rest);
      if (idEnd !== -1 && endsCleanly(text, idEnd)) end = idEnd;
    }
    if (end === -1) continue;
    out.push({ source, id: text.slice(end - 8, end), column: p + 1 });
    p = end - 1;
  }
  return out;
}

/**
 * The anchors in a tree, with one `git grep`: the work tree (tracked and untracked, not ignored,
 * files), the index, or a commit. Binary files and submodules are skipped; `excludeDirs` (such as
 * the log root) are left out as literal pathspecs and paths matching an `exclude` glob are dropped
 * afterwards. Sorted by path, then line. Throws `InvalidArgumentError` for an invalid keyword,
 * path, commit or `exclude` glob.
 */
export async function scanAnchors(
  git: Git,
  o: {
    readonly keyword: string;
    readonly tree: "worktree" | "index" | { readonly commit: string };
    /** Default: the whole tree. */
    readonly paths?: readonly string[];
    /** Directories, e.g. the log root; passed to git as literal exclude pathspecs. */
    readonly excludeDirs?: readonly string[];
    /** Scope globs (design §3.1), e.g. `docs/**`; a post-filter. */
    readonly exclude?: readonly string[];
  },
): Promise<Anchor[]> {
  if (!KEYWORD.test(o.keyword)) {
    throw new InvalidArgumentError(
      `invalid anchor keyword ${JSON.stringify(o.keyword)}: must match ${KEYWORD.source}`,
    );
  }
  for (const g of o.exclude ?? []) {
    const r = parseGlob(g);
    if (!r.ok) throw new InvalidArgumentError(r.message);
  }
  const excluded = globMatcher(o.exclude ?? []);
  for (const p of [...(o.paths ?? []), ...(o.excludeDirs ?? [])]) assertPath(p);

  let treeArgs: string[];
  let prefix = "";
  if (o.tree === "worktree") {
    requireWorkTree(git);
    treeArgs = ["--untracked"];
  } else if (o.tree === "index") {
    treeArgs = ["--cached"];
  } else {
    assertRev(o.tree.commit);
    treeArgs = [o.tree.commit];
    prefix = `${o.tree.commit}:`;
  }
  const paths = o.paths === undefined ? ["."] : o.paths.map((p) => `:(literal)${p}`);
  if (paths.length === 0) return [];
  const pattern = `${o.keyword}:([a-z][a-z0-9-]{0,31}:)?[0-9a-hjkmnp-tv-z]{8}`;
  const r = await git.run(
    [
      "grep",
      "-n",
      "-z",
      "-I",
      "--full-name",
      "--no-color",
      "--no-column",
      "--no-textconv",
      "--no-recurse-submodules",
      "-E",
      "-e",
      pattern,
      ...treeArgs,
      "--",
      ...paths,
      ...(o.excludeDirs ?? []).map((d) => `:(exclude,literal)${d}`),
    ],
    { okCodes: [0, 1] },
  );

  // Each match is `path\0line\0text\n`; paths may hold newlines, texts never do.
  const out: Anchor[] = [];
  const text = Buffer.from(r.stdout).toString("utf8");
  let i = 0;
  while (i < text.length) {
    const a = text.indexOf("\0", i);
    const b = a === -1 ? -1 : text.indexOf("\0", a + 1);
    if (b === -1) break;
    const nl = text.indexOf("\n", b + 1);
    const end = nl === -1 ? text.length : nl;
    let path = text.slice(i, a);
    if (prefix !== "" && path.startsWith(prefix)) path = path.slice(prefix.length);
    const line = Number(text.slice(a + 1, b));
    const content = text.slice(b + 1, end);
    i = end + 1;
    if (excluded(path).length > 0) continue;
    for (const m of anchorsInLine(content, o.keyword)) {
      out.push({ path, line, source: m.source, id: m.id });
    }
  }
  return out.sort((x, y) => (x.path === y.path ? x.line - y.line : x.path < y.path ? -1 : 1));
}
