/**
 * The index × `--commit` invariant over random write sequences (test-support/index-invariant.ts).
 */
import { rm } from "node:fs/promises";
import { createTempRepo } from "@nikovirtala/ledger/testing";
import fc from "fast-check";
import { afterEach, describe, it } from "vitest";
import type { AppliedPlan } from "./apply.js";
import { initIssueLog } from "./init.js";
import type { IssueLog } from "./log.js";
import {
  assertInvariants,
  CONFIG,
  disposeRepos,
  me,
  newIssue,
  open,
  ROOT,
  repos,
  SECTIONS,
  stagedBlobs,
} from "./test-support/index-invariant.js";
import {
  assignIssue,
  commentIssue,
  editIssue,
  type IssueWriteJson,
  labelIssue,
  linkIssue,
  openIssue,
} from "./write.js";

afterEach(disposeRepos);

describe("index property", { timeout: 600_000 }, () => {
  it("keeps the invariant over random write sequences", async () => {
    type Step = { readonly op: number; readonly who: number; readonly commit: boolean };
    const step = fc.record({
      op: fc.integer({ min: 0, max: 5 }),
      who: fc.integer({ min: 0, max: 2 }),
      commit: fc.boolean(),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 3, maxLength: 6 }), async (steps: Step[]) => {
        const r = await createTempRepo({
          files: { "README.md": "readme\n", [`${ROOT}/issues.toml`]: CONFIG },
        });
        repos.push(r);
        await initIssueLog(await open(r), { commit: true });
        const ids = [
          await newIssue(r, "First", true),
          await newIssue(r, "Second", true),
          await newIssue(r, "Third", false),
        ];
        for (const s of steps) {
          const log: IssueLog = await open(r);
          const id = ids[s.who] as string;
          const o = { commit: s.commit };
          const before = await stagedBlobs(r);
          let doc: IssueWriteJson | AppliedPlan | null = null;
          switch (s.op) {
            case 0:
              doc = await commentIssue(log, { id, text: "Note.", actor: me }, o);
              break;
            case 1:
              doc = await labelIssue(log, { id, op: { add: ["type:bug"] }, actor: me }, o);
              break;
            case 2:
              doc = await editIssue(log, { id, title: `Title ${s.who} ${s.op}` }, o);
              break;
            case 3:
              doc = await linkIssue(log, { id, to: ids[(s.who + 1) % 3] as string, actor: me }, o);
              break;
            case 4:
              doc = await openIssue(log, { title: "Another", sections: SECTIONS, actor: me }, o);
              break;
            default:
              doc = await assignIssue(log, { id, op: { add: ["ada@example.com"] }, actor: me }, o);
          }
          if (doc !== null && "ok" in doc && doc.ok && doc.commit !== null) {
            await assertInvariants(r, doc, before);
          }
        }
        await rm(r.root, { recursive: true, force: true });
      }),
      { numRuns: 20 },
    );
  });
});
