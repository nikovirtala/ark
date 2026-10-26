import { createTempRepo } from "@nikovirtala/ledger/testing";
import { describe, expect, it } from "vitest";
import { issueCommits } from "./commits.js";
import { openIssueLog } from "./log.js";

const ID = "m4p8x2kd";

describe("issueCommits", () => {
  it("finds commits by their Issue trailer, merged branches included", async () => {
    await using repo = await createTempRepo({ files: { "README.md": "x\n" } });
    await repo.write("a.txt", "a\n");
    await repo.stage("a.txt");
    const one = await repo.commit("fix: one", {
      trailers: [
        ["Issue", ID],
        ["Issue-Event", "closed"],
        ["Issue", "zzzzzzzz"],
        ["Issue-Event", "started"],
      ],
    });
    await repo.checkout("side", { create: true });
    await repo.write("b.txt", "b\n");
    await repo.stage("b.txt");
    const side = await repo.commit(`feat: side work\n\nMentions ${ID} in the body.`, {
      trailers: [["issue", ID]],
    });
    await repo.checkout("main");
    await repo.write("c.txt", "c\n");
    await repo.stage("c.txt");
    await repo.commit("chore: other", { trailers: [["Issue", ID.toUpperCase()]] });
    await repo.write("d.txt", "d\n");
    await repo.stage("d.txt");
    await repo.commit(`docs: names ${ID} only in the subject`);
    await repo.merge("side", { noFf: true, message: "Merge side" });

    const log = await openIssueLog({ cwd: repo.root, gitOptions: { env: repo.env } });
    const found = await issueCommits(log, ID);
    expect(found.map((c) => [c.sha, c.subject, c.events])).toEqual([
      [side, "feat: side work", []],
      [one, "fix: one", ["closed"]],
    ]);
    expect(found[0]?.author_date).toMatch(/^\d{4}-\d\d-\d\dT/);

    const atOne = await openIssueLog({ cwd: repo.root, ref: one, gitOptions: { env: repo.env } });
    expect((await issueCommits(atOne, ID)).map((c) => c.sha)).toEqual([one]);
  });

  it("is empty on an unborn HEAD", async () => {
    await using repo = await createTempRepo();
    const log = await openIssueLog({ cwd: repo.root, gitOptions: { env: repo.env } });
    expect(log.commit).toBeNull();
    expect(await issueCommits(log, ID)).toEqual([]);
  });
});
