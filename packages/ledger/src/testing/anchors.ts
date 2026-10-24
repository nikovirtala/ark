import { InvalidArgumentError } from "../errors.js";
import { newSubjectId } from "../identity/ids.js";

const KEYWORD = /^[a-z][a-z0-9-]{0,31}$/;

/** mulberry32: a small deterministic generator, enough to pick ids from a seed. */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/**
 * A code file with one local anchor that names no subject, for verifier-mutation tests: a path
 * under `src/`, the text `// <keyword>:<id>\n`, and the id, which is outside `taken`. The same
 * seed and `taken` give the same result. Throws `InvalidArgumentError` for an invalid keyword or
 * a seed that isn't an integer.
 */
export function danglingAnchor(o: {
  readonly keyword: string;
  readonly taken: ReadonlySet<string>;
  readonly seed: number;
}): { readonly path: string; readonly text: string; readonly id: string } {
  if (!KEYWORD.test(o.keyword)) {
    throw new InvalidArgumentError(`invalid anchor keyword ${JSON.stringify(o.keyword)}`);
  }
  if (!Number.isInteger(o.seed)) {
    throw new InvalidArgumentError(`seed must be an integer, got ${o.seed}`);
  }
  const next = generator(o.seed);
  const fill = (b: Uint8Array) => {
    for (let i = 0; i < b.length; i++) b[i] = next() & 0xff;
  };
  let id = newSubjectId(fill);
  while (o.taken.has(id)) id = newSubjectId(fill);
  return { path: `src/dangling-${id}.ts`, text: `// ${o.keyword}:${id}\n`, id };
}
