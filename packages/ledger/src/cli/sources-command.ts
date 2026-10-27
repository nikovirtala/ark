import { type JsonValue, UsageError } from "../errors.js";
import type { Git } from "../git/git.js";
import type { SourceConfig } from "../sources/config.js";
import { readSources, type SourceStatus } from "../sources/read.js";
import type { GlobalFlags } from "./flags.js";
import type { CliIO } from "./output.js";
import type { CommandSpec } from "./run.js";

export interface SourcesCommandOptions {
  /** The JSON document's `format`, for example `"adr-sources/v1"`. */
  readonly format: string;
  /** The tool's name, for the skipped lines and the usage errors. */
  readonly tool: string;
  /**
   * Opens the tool's config: `sources` are the `[[sources]]` entries of the kinds the tool reads,
   * `skipped` the others (never fetched), both in config order.
   */
  open(ctx: { readonly io: CliIO; readonly flags: GlobalFlags }): Promise<{
    readonly git: Git;
    readonly sources: readonly SourceConfig[];
    readonly skipped: readonly SourceConfig[];
    /** The config file, for the message without sources; default `<tool>.toml`. */
    readonly configPath?: string | null;
    readonly notes?: readonly string[];
  }>;
}

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_NAMES = 32;

/**
 * The shared `sources fetch [<name>…]` command: fetches the named sources (default every source
 * the tool reads) into the local cache, in config order, with `readSources`' network mode. The
 * first failure exits 2 naming that source; the sources fetched before it keep their new pins.
 */
export function sourcesCommand(o: SourcesCommandOptions): CommandSpec {
  return {
    name: "sources",
    summary: "fetch other repositories' logs into the local cache",
    usage: "sources fetch [<name>…]",
    options: {},
    positionals: { min: 1, max: 1 + MAX_NAMES, names: ["fetch", "name"] },
    ref: "reject",
    async run({ io, flags, positionals }) {
      const [action, ...names] = positionals;
      if (action !== "fetch") {
        throw new UsageError(`unknown sources action ${JSON.stringify(action)}; use fetch`);
      }
      for (const n of names) {
        if (!NAME.test(n)) throw new UsageError(`source names must match ${NAME.source}: ${n}`);
      }
      const log = await o.open({ io, flags });
      const wanted = new Set(names);
      const all = [...log.sources, ...log.skipped];
      for (const n of wanted) {
        const skipped = log.skipped.find((s) => s.name === n);
        if (skipped !== undefined) {
          throw new UsageError(
            `source ${n} has kind ${skipped.kind}, which ${o.tool} doesn't read`,
          );
        }
        if (!all.some((s) => s.name === n)) {
          const known = all.map((s) => s.name);
          throw new UsageError(
            known.length === 0
              ? `unknown source ${n}; there are no sources`
              : `unknown source ${n}; the sources are ${known.join(", ")}`,
          );
        }
      }
      const chosen =
        wanted.size === 0 ? log.sources : log.sources.filter((s) => wanted.has(s.name));
      const skipped = wanted.size === 0 ? log.skipped : [];
      const reads = await readSources(log.git, chosen, { fetch: "network" });
      const statuses: SourceStatus[] = reads.map((r) => r.status);
      const lines = [
        ...statuses.map((s) => `fetched ${s.name} (${s.ref}) at ${(s.commit ?? "").slice(0, 12)}`),
        ...skipped.map((s) => `skipped ${s.name} (kind ${s.kind} isn't read by ${o.tool})`),
      ];
      const notes = [...(log.notes ?? [])];
      const json = {
        format: o.format,
        sources: statuses.map((s) => ({ ...s })),
        skipped: skipped.map((s) => ({ name: s.name, kind: s.kind })),
        notes,
      };
      return {
        exit: 0,
        json: json as unknown as JsonValue,
        text:
          all.length === 0
            ? `no [[sources]] in ${log.configPath ?? `${o.tool}.toml`}`
            : lines.join("\n"),
        ...(notes.length === 0 ? {} : { notes }),
      };
    },
  };
}
