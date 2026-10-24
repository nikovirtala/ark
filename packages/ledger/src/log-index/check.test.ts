import { describe, expect, it } from "vitest";
import { compileKind } from "../envelope/kind.js";
import { finding } from "../findings/finding.js";
import { MemoryTree } from "../git/tree.js";
import { exampleKind, exampleLayout as layout } from "../testing/example-kind.js";
import type { CheckContext } from "../verify/checks.js";
import { verifySnapshots } from "../verify/verify.js";
import { indexCheck } from "./check.js";

const kind = compileKind(exampleKind);
const PATH = "log/index.md";
const FRESH = "# Index\n";

const check = (expected: string | null) =>
  indexCheck({ path: PATH, fix: "run t index", expected: async () => expected });

const verify = (
  base: Record<string, string> | null,
  head: Record<string, string>,
  o: { scope?: "all" | "changed"; expected?: string | null } = {},
) =>
  verifySnapshots({
    kind,
    layout,
    base: base === null ? null : new MemoryTree(base),
    head: new MemoryTree(head),
    scope: o.scope ?? "all",
    checks: [check(o.expected === undefined ? FRESH : o.expected)],
  });

const at = (severity: "error" | "warning", rule: string, message: string) =>
  finding({ severity, rule, message, file: PATH, subject: null, kind: "widget" });

describe("indexCheck", () => {
  it("passes a fresh index", async () => {
    expect(await verify(null, { [PATH]: FRESH })).toEqual([]);
  });

  it("reports a missing index", async () => {
    expect(await verify(null, { "log/other.md": "x\n" })).toEqual([
      at("error", "index/missing", `${PATH} is missing; run t index and commit it`),
    ]);
  });

  it("warns when the expected bytes can't be computed", async () => {
    expect(await verify(null, { [PATH]: FRESH }, { expected: null })).toEqual([
      at(
        "warning",
        "index/unchecked",
        `${PATH} can't be checked here: numbers need history in a shallow clone without a recorded index; run git fetch --unshallow`,
      ),
    ]);
  });

  it("reports a stale index", async () => {
    expect(await verify(null, { [PATH]: "# Old\n" })).toEqual([
      at(
        "error",
        "index/stale",
        `${PATH} is not what the tool generates; run t index and commit it`,
      ),
    ]);
  });

  it("is skipped in scope changed when the log didn't change, and runs when it did", async () => {
    const stale = { [PATH]: "# Old\n" };
    expect(await verify(stale, stale, { scope: "changed" })).toEqual([]);
    expect(await verify(stale, { ...stale, "log/note.md": "x\n" }, { scope: "changed" })).toEqual([
      at(
        "error",
        "index/stale",
        `${PATH} is not what the tool generates; run t index and commit it`,
      ),
    ]);
  });

  it("hands expected the check context", async () => {
    let seen: CheckContext | null = null;
    const c = indexCheck({
      path: PATH,
      fix: "run t index",
      expected: async (ctx) => {
        seen = ctx;
        return FRESH;
      },
    });
    await verifySnapshots({
      kind,
      layout,
      base: null,
      head: new MemoryTree({ [PATH]: FRESH }),
      scope: "all",
      checks: [c],
    });
    expect(c.id).toBe("index");
    expect((seen as CheckContext | null)?.head.tree.label).toBe("memory");
  });
});
