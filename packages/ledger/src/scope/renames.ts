/**
 * Rename following (design §3.4): rewrites scope globs after staged renames so that no file a
 * glob covered stops being covered, and reports the files that become covered.
 */
import type { Git } from "../git/git.js";
import { escapeGlob, type Glob, type GlobProblem, parseGlob } from "./glob.js";

export interface Rename {
  readonly from: string;
  readonly to: string;
}

/**
 * The renames staged against `HEAD`, from `git diff --cached -M --name-status -z --no-ext-diff
 * HEAD --`: git's similarity detection decides what is a rename, and copies are ignored. `[]` on
 * an unborn `HEAD`.
 */
export async function stagedRenames(git: Git): Promise<Rename[]> {
  if ((await git.resolveCommit("HEAD")) === null) return [];
  const r = await git.run([
    "diff",
    "--cached",
    "-M",
    "--name-status",
    "-z",
    "--no-ext-diff",
    "--no-relative",
    "HEAD",
    "--",
  ]);
  const fields = Buffer.from(r.stdout).toString("utf8").split("\0");
  const out: Rename[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i] ?? "";
    if (status === "") break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = fields[i + 1] ?? "";
      const to = fields[i + 2] ?? "";
      if (status.startsWith("R")) out.push({ from, to });
      i += 3;
    } else {
      i += 2;
    }
  }
  return out;
}

export interface FollowResult {
  /** Sorted, deduplicated. */
  readonly globs: readonly string[];
  /** `globs` differs from the sorted, deduplicated input. */
  readonly changed: boolean;
  /** Each input glob that was replaced, in input order, with what replaced it. */
  readonly rewritten: readonly { readonly from: string; readonly to: readonly string[] }[];
  /** Files in `after` the new globs cover whose origin the old globs didn't. */
  readonly gained: readonly string[];
  /** Renames of covered files whose target can't be written as a glob (`escapeGlob`'s limits). */
  readonly skipped: readonly {
    readonly from: string;
    readonly to: string;
    readonly problem: GlobProblem;
  }[];
}

const canonical = (xs: Iterable<string>) => [...new Set(xs)].sort();

/** The single `P'` with `r.from = prefix/<s>` and `r.to = P'/<s>` for every rename, or null. */
function movedPrefix(prefix: string, renames: readonly Rename[]): string | null {
  let target: string | null = null;
  for (const r of renames) {
    if (!r.from.startsWith(`${prefix}/`)) return null;
    const suffix = r.from.slice(prefix.length);
    if (!r.to.endsWith(suffix) || r.to.length === suffix.length) return null;
    const p = r.to.slice(0, r.to.length - suffix.length);
    if (target !== null && p !== target) return null;
    target = p;
  }
  return target;
}

/**
 * Follows `renames` in `globs` (design §3.4). `before` and `after` are the tracked files before
 * (`HEAD`) and after (the index). Pure. Invalid globs are kept unchanged.
 */
export function followRenames(o: {
  readonly globs: readonly string[];
  readonly renames: readonly Rename[];
  readonly before: readonly string[];
  readonly after: readonly string[];
}): FollowResult {
  // A rename whose target `escapeGlob` can't express is treated as if it weren't there.
  const usable: Rename[] = [];
  const unusable: { from: string; to: string; problem: GlobProblem }[] = [];
  for (const r of o.renames) {
    const parsed = parseGlob(escapeGlob(r.to));
    if (parsed.ok) usable.push(r);
    else unusable.push({ from: r.from, to: r.to, problem: parsed.problem });
  }

  const out: string[] = [];
  const rewritten: { from: string; to: string[] }[] = [];
  const oldGlobs: Glob[] = [];
  for (const source of o.globs) {
    const parsed = parseGlob(source);
    if (!parsed.ok) {
      out.push(source);
      continue;
    }
    const g = parsed.glob;
    oldGlobs.push(g);
    const matched = new Set(o.before.filter((f) => g.matches(f)));
    const moved = usable.filter((r) => matched.has(r.from));
    if (moved.length === 0) {
      out.push(source);
      continue;
    }
    const stays = o.after.some((f) => g.matches(f));
    const result: Glob[] = [];
    const literal = (path: string) => (parseGlob(escapeGlob(path)) as { glob: Glob }).glob;

    if (g.literal !== null) {
      // Step 2: the literal follows its rename; a new file at the old path keeps it too.
      if (stays) result.push(g);
      for (const r of moved) result.push(literal(r.to));
    } else {
      // Step 3: the directory-move shape, every matched file moved from one prefix to one P'.
      const movedFrom = new Set(moved.map((r) => r.from));
      const targets = new Set(moved.map((r) => r.to));
      const allMoved = [...matched].every((f) => movedFrom.has(f));
      const target = g.prefixSegments > 0 && allMoved ? movedPrefix(g.prefix, moved) : null;
      let next: Glob | null = null;
      if (target !== null) {
        const candidate = parseGlob(
          [escapeGlob(target), ...g.segments.slice(g.prefixSegments)].join("/"),
        );
        if (candidate.ok) {
          const covered = o.after.filter((f) => candidate.glob.matches(f));
          const exact = covered.length === targets.size && covered.every((f) => targets.has(f));
          if (exact) next = candidate.glob;
        }
      }
      if (next !== null && !stays) {
        result.push(next);
      } else {
        // Step 4: keep the glob if it still matches, then cover every moved file.
        if (stays) result.push(g);
        if (next !== null) result.push(next);
        for (const r of moved) {
          if (!result.some((k) => k.matches(r.to))) result.push(literal(r.to));
        }
      }
    }
    const sources = result.map((k) => k.source);
    out.push(...sources);
    if (sources.length !== 1 || sources[0] !== source) {
      rewritten.push({ from: source, to: sources });
    }
  }

  const globs = canonical(out);
  const before = canonical(o.globs);
  const newGlobs = globs.flatMap((s) => {
    const r = parseGlob(s);
    return r.ok ? [r.glob] : [];
  });
  const skipped = unusable.filter((r) => oldGlobs.some((g) => g.matches(r.from)));
  const origin = new Map(o.renames.map((r) => [r.to, r.from]));
  const skippedTo = new Set(skipped.map((s) => s.to));
  const gained = o.after.filter((f) => {
    if (skippedTo.has(f)) return false;
    const from = origin.get(f) ?? f;
    return newGlobs.some((g) => g.matches(f)) && !oldGlobs.some((g) => g.matches(from));
  });
  return {
    globs,
    changed: globs.length !== before.length || globs.some((g, i) => g !== before[i]),
    rewritten,
    gained: canonical(gained),
    skipped,
  };
}
