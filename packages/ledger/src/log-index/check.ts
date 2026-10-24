import { type Finding, finding } from "../findings/finding.js";
import type { Check, CheckContext } from "../verify/checks.js";

const encoder = new TextEncoder();

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.byteLength === b.byteLength && a.every((x, i) => x === b[i]);

/**
 * The verify check that a generated index at `path` is what the tool renders for `ctx.head`
 * (`index/missing`, `index/stale`, or the `index/unchecked` warning when `expected` can't compute
 * the bytes). It runs in scope `all`, and in scope `changed` only when the log has changes, so a
 * commit that touches the log checks it and other commits stay fast.
 */
export function indexCheck(o: {
  readonly path: string;
  /**
   * The bytes the index must have for `ctx.head`, or null when they can't be computed (shallow,
   * nothing recorded).
   */
  readonly expected: (ctx: CheckContext) => Promise<string | null>;
  /** The fix the findings name, such as `"run adr index"`. */
  readonly fix: string;
}): Check {
  const { path, fix } = o;
  const at = (severity: Finding["severity"], rule: string, message: string) =>
    finding({ severity, rule, message, file: path, subject: null });
  return {
    id: "index",
    async run(ctx) {
      if (ctx.scope === "changed" && ctx.changes.length === 0) return [];
      const actual = await ctx.head.tree.read(path);
      if (actual === null)
        return [at("error", "index/missing", `${path} is missing; ${fix} and commit it`)];
      const expected = await o.expected(ctx);
      if (expected === null) {
        return [
          at(
            "warning",
            "index/unchecked",
            `${path} can't be checked here: numbers need history in a shallow clone without a recorded index; run git fetch --unshallow`,
          ),
        ];
      }
      if (sameBytes(actual, encoder.encode(expected))) return [];
      return [
        at("error", "index/stale", `${path} is not what the tool generates; ${fix} and commit it`),
      ];
    },
  };
}
