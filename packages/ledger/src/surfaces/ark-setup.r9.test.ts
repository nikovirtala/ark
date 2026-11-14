import { describe, expect, it } from "vitest";

/** The R9 comparison (`scripts/check-agent-setup.mjs`): bytes and git mode (?77). */
const { diffSetup } = (await import(
  new URL("../../../../scripts/check-agent-setup.mjs", import.meta.url).href
)) as {
  diffSetup(
    want: Record<string, { text: string; mode: string | null }>,
    got: Record<string, { text: string; mode: string | null } | null>,
  ): string[];
};

const file = (text: string, mode = "100644") => ({ text, mode });

describe("R9 compares modes as well as bytes", () => {
  it("passes when every file has the committed bytes and mode", () => {
    const want = { "a.sh": file("x", "100755"), "b.json": file("y") };
    expect(diffSetup(want, { "a.sh": file("x", "100755"), "b.json": file("y") })).toEqual([]);
  });

  it("reports a hook script init wrote without its execute bit", () => {
    const want = { ".claude/hooks/a.sh": file("x", "100755") };
    expect(diffSetup(want, { ".claude/hooks/a.sh": file("x", "100644") })).toEqual([
      ".claude/hooks/a.sh (mode 100644, committed 100755)",
    ]);
  });

  it("reports a committed script that lost its bit, which init would restore", () => {
    const want = { "a.sh": file("x", "100644") };
    expect(diffSetup(want, { "a.sh": file("x", "100755") })).toEqual([
      "a.sh (mode 100755, committed 100644)",
    ]);
  });

  it("reports a file init did not write and one with other bytes, by name", () => {
    const want = { "a.sh": file("x", "100755"), "b.json": file("y"), "c.md": file("z") };
    const got = { "a.sh": file("other", "100755"), "b.json": null, "c.md": file("z") };
    expect(diffSetup(want, got)).toEqual(["a.sh", "b.json"]);
  });

  it("reports a staged mode that disagrees with the file system's", () => {
    const want = { "a.sh": file("x", "100755") };
    expect(diffSetup(want, { "a.sh": file("x", "100755/100644") })).toEqual([
      "a.sh (mode 100755/100644, committed 100755)",
    ]);
  });
});
