import { parseTrailerBlock } from "@nikovirtala/ledger";
import type { IssueLog } from "./log.js";
import type { IssueCommitJson } from "./views.js";

const decoder = new TextDecoder();
const RECORD = "\x1e";
const FIELD = "\x00";

/**
 * The commits whose trailers name the issue `id` (`show --commits`): an `Issue` trailer (key
 * compared ignoring case, as git does) whose value is exactly the id, with the `Issue-Event`
 * values that follow it. Walks every commit reachable from `log.commit` (the `--ref` commit, else
 * HEAD), merged branches included, newest first; `[]` when HEAD is unborn. The id is a cheap
 * `--grep` prefilter before the trailers are parsed.
 */
export async function issueCommits(log: IssueLog, id: string): Promise<IssueCommitJson[]> {
  if (log.commit === null) return [];
  const r = await log.git.run([
    "log",
    "--format=%H%x00%s%x00%aI%x00%(trailers:only,unfold)%x1e",
    "--fixed-strings",
    "--regexp-ignore-case",
    `--grep=${id}`,
    log.commit,
    "--",
  ]);
  const out: IssueCommitJson[] = [];
  for (const record of decoder.decode(r.stdout).split(RECORD)) {
    const [sha = "", subject = "", date = "", trailers = ""] = record
      .replace(/^\n/, "")
      .split(FIELD);
    if (sha === "") continue;
    const pairs = parseTrailerBlock(trailers);
    let named = false;
    let ours = false;
    const events: string[] = [];
    for (const [key, value] of pairs) {
      const k = key.toLowerCase();
      if (k === "issue") {
        ours = value === id;
        named ||= ours;
      } else if (k === "issue-event" && ours) {
        events.push(value);
        ours = false;
      }
    }
    if (named) out.push({ sha, subject, author_date: date, events });
  }
  return out;
}
