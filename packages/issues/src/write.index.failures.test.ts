/**
 * How committing writes clean up when rendering the index fails (test-support/index-invariant.ts).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventEnvelope } from "@nikovirtala/ledger";
import { createTempRepo, type TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { applyPlan } from "./apply.js";
import { initIssueLog } from "./init.js";
import {
  arrange,
  CONFIG,
  disposeRepos,
  git,
  INDEX,
  keep,
  me,
  open,
  ROOT,
  ROWS,
  type Row,
  repos,
  SECTIONS,
} from "./test-support/index-invariant.js";
import { commentIssue, openIssue, type WriteDeps } from "./write.js";

afterEach(disposeRepos);

describe("index failures", { timeout: 120_000 }, () => {
  async function base(): Promise<{ r: TempRepo; x: string }> {
    const { c } = await arrange(1, ROWS[0] as Row);
    return { r: c.r, x: c.x };
  }
  const failing =
    (when: number): WriteDeps["apply"] =>
    (log, plan, o) => {
      let n = 0;
      const index = o.index;
      return applyPlan(log, plan, {
        ...o,
        ...(index === undefined
          ? {}
          : {
              index: async (tree, history) => {
                n += 1;
                if (n === when) throw new Error("render failed");
                return index(tree, history);
              },
            }),
      });
    };
  const deps = (apply: WriteDeps["apply"]): WriteDeps => ({ now: Date.now, apply });

  it("leaves nothing behind when the first render fails", async () => {
    const { r, x } = await base();
    const status = await git(r, "status", "--porcelain");
    const log = await open(r);
    await expect(
      commentIssue(
        log,
        { id: x, text: "A comment.", actor: me },
        { commit: true },
        deps(failing(1)),
      ),
    ).rejects.toThrow("render failed");
    expect(await git(r, "status", "--porcelain")).toBe(status);
  });

  it("commits and notes a stale work-tree copy when the render after the commit fails", async () => {
    const { r, x } = await base();
    const doc = await commentIssue(
      await open(r),
      { id: x, text: "A comment.", actor: me },
      { commit: true },
      deps(failing(2)),
    );
    expect(doc.commit).not.toBeNull();
    expect(doc.notes).toContain(`${INDEX} may be stale: render failed; run issues index`);
  });

  it("throws CommitFailedError with the index step when the editor-step render fails", async () => {
    const r = await createTempRepo({ files: { [`${ROOT}/issues.toml`]: CONFIG } });
    repos.push(r);
    await initIssueLog(await open(r), { commit: true });
    await expect(
      openIssue(
        await open(r),
        { title: "Drafted", sections: SECTIONS, actor: me },
        { commit: true, edit: keep },
        deps(failing(2)),
      ),
    ).rejects.toMatchObject({ name: "CommitFailedError" });
    expect(await git(r, "diff", "--cached", "--name-only")).toContain(INDEX);
  });

  it("restores the old index bytes and removes a new index when a write fails after placing it", async () => {
    const { r, x } = await base();
    const old = await readFile(join(r.root, INDEX), "utf8");
    const apply: WriteDeps["apply"] = (log, plan, o) =>
      applyPlan(
        log,
        { ...plan, events: [...plan.events, { ...(plan.events[0] as EventEnvelope), id: "bad" }] },
        o,
      );
    await expect(
      commentIssue(
        await open(r),
        { id: x, text: "A comment.", actor: me },
        { commit: true },
        deps(apply),
      ),
    ).rejects.toThrow();
    expect(await readFile(join(r.root, INDEX), "utf8")).toBe(old);
    await git(r, "rm", "-qf", "--", INDEX);
    await git(r, "commit", "-qm", "chore: drop the index", "--", INDEX);
    await expect(
      commentIssue(
        await open(r),
        { id: x, text: "Again.", actor: me },
        { commit: true },
        deps(apply),
      ),
    ).rejects.toThrow();
    await expect(readFile(join(r.root, INDEX))).rejects.toThrow();
  });
});
