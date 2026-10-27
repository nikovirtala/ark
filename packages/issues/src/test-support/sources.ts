import { readFile } from "node:fs/promises";
import { openDecisionLog, proposeDecision } from "@nikovirtala/adr";
import { createTempRepo, type TempRepo } from "@nikovirtala/ledger/testing";
import { cliRepo, newIssue, REPO_HUMAN } from "./cli.js";

/** A source repository with an issue log (index committed) and a decision log, pushed bare. */
export interface IssueSourceFixture {
  readonly src: TempRepo;
  readonly bare: TempRepo;
  /** The bare repository's path, for a `[[sources]]` url. */
  readonly url: string;
  /** The ids of the open issues, in order (`?1`, `?2`, …). */
  readonly issues: readonly string[];
  /** A proposed decision's id. */
  readonly decision: string;
  /** Commits a new issue in the source and pushes it; its id. */
  add(title: string): Promise<string>;
}

/** The fixture: `titles` opened and committed, a proposed decision, tag `v1`, pushed bare. */
export async function issueSource(
  titles: readonly string[] = ["Provide the platform API"],
): Promise<IssueSourceFixture> {
  const src = await cliRepo({ "docs/issues/issues.toml": '[log]\nindex = "committed"\n' });
  const issues = titles.map((t) => newIssue(src, t));
  const log = await openDecisionLog({ cwd: src.root, gitOptions: { env: src.env } });
  const p = await proposeDecision(
    log,
    {
      title: "Use a platform queue",
      sections: { context: "C.", decision: "D.", scope: "S.", consequences: "- C." },
      actor: REPO_HUMAN,
    },
    { commit: true },
  );
  await src.git.run(["tag", "-a", "v1", "-m", "v1"]);
  const bare = await createTempRepo({ bare: true });
  const push = () => src.git.run(["push", "-q", "--follow-tags", bare.root, "main"]);
  await push();
  return {
    src,
    bare,
    url: bare.root,
    issues,
    decision: p.decision?.id ?? "",
    async add(title) {
      const id = newIssue(src, title);
      await push();
      return id;
    },
  };
}

/** `[[sources]]` text. */
export function sourceToml(
  name: string,
  url: string,
  o: { readonly ref?: string; readonly kind?: string; readonly root?: string } = {},
): string {
  return `\n[[sources]]\nname = "${name}"\nkind = "${o.kind ?? "issues"}"\nurl = "${url}"\nref = "${o.ref ?? "main"}"\n${o.root === undefined ? "" : `root = "${o.root}"\n`}`;
}

/** The git commands a `GIT_TRACE2_EVENT` file records that reach a remote. */
export async function networkCommands(trace: string): Promise<string[]> {
  const raw = await readFile(trace, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as { event: string; argv?: string[] })
    .filter((e) => e.event === "start" || e.event === "child_start")
    .map((e) => (e.argv ?? []).join(" "))
    .filter((a) => /(^|\s)(fetch|ls-remote)(\s|$)|remote-/.test(a));
}
