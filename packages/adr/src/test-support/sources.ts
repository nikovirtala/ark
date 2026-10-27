import { readFile } from "node:fs/promises";
import { createTempRepo, type TempRepo } from "@nikovirtala/ledger/testing";
import { cliRepo, seedDecision } from "./cli.js";

/** A source repository with a decision log, pushed to a bare repository that consumers fetch. */
export interface DecisionSourceFixture {
  readonly src: TempRepo;
  readonly bare: TempRepo;
  /** The bare repository's path, for a `[[sources]]` url. */
  readonly url: string;
  /** The ids of the accepted decisions, in order. */
  readonly ids: readonly string[];
  /** Commits a new decision in the source and pushes it; its id. */
  add(title: string): Promise<string>;
}

/**
 * A source decision log with `titles` accepted (and a committed `index.md`, so consumers see its
 * numbers), tagged `v1` (annotated) and pushed with the tag to a bare repository. The caller
 * disposes `src` and `bare`.
 */
export async function decisionSource(
  titles: readonly string[] = ["Use Aurora for orders"],
): Promise<DecisionSourceFixture> {
  const src = await cliRepo({ "docs/adr/adr.toml": '[log]\nindex = "committed"\n' });
  const ids: string[] = [];
  for (const t of titles) ids.push(await seedDecision(src, t));
  await src.git.run(["tag", "-a", "v1", "-m", "v1"]);
  const bare = await createTempRepo({ bare: true });
  const push = () => src.git.run(["push", "-q", "--follow-tags", bare.root, "main"]);
  await push();
  return {
    src,
    bare,
    url: bare.root,
    ids,
    async add(title) {
      const id = await seedDecision(src, title);
      await push();
      return id;
    },
  };
}

/** `[[sources]]` text for a source named `name`. */
export function sourceToml(
  name: string,
  url: string,
  o: { readonly ref?: string; readonly kind?: string } = {},
): string {
  return `\n[[sources]]\nname = "${name}"\nkind = "${o.kind ?? "adr"}"\nurl = "${url}"\nref = "${o.ref ?? "main"}"\n`;
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
