import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InvalidArgumentError } from "../errors.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { writeIndexFile } from "./write.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(): Promise<TempRepo> {
  const r = await createTempRepo({ files: { "log/index.md": "# Old\n" } });
  repos.push(r);
  return r;
}

describe("writeIndexFile", () => {
  it("returns false and leaves the file untouched for equal bytes", async () => {
    const r = await repo();
    const full = join(r.root, "log/index.md");
    const before = await stat(full);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await writeIndexFile(r.git, "log/index.md", "# Old\n")).toBe(false);
    const after = await stat(full);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
  });

  it("replaces the file by an atomic rename, leaving no temp file", async () => {
    const r = await repo();
    const full = join(r.root, "log/index.md");
    const before = await stat(full);
    expect(await writeIndexFile(r.git, "log/index.md", "# New\n")).toBe(true);
    const after = await stat(full);
    expect(await readFile(full, "utf8")).toBe("# New\n");
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o644);
    expect(await readdir(join(r.root, "log"))).toEqual(["index.md"]);
  });

  it("creates a missing file and its directory", async () => {
    const r = await repo();
    expect(await writeIndexFile(r.git, "docs/adr/index.md", "# A\n")).toBe(true);
    expect(await readFile(join(r.root, "docs/adr/index.md"), "utf8")).toBe("# A\n");
  });

  it.each(["-x", "/abs/index.md", "log/../index.md", "log//index.md"])(
    "refuses the path %j",
    async (path) => {
      const r = await repo();
      await expect(writeIndexFile(r.git, path, "x")).rejects.toBeInstanceOf(InvalidArgumentError);
    },
  );
});
