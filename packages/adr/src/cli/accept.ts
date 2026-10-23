import { type JsonValue, resolveAttribution } from "@nikovirtala/ledger";
import {
  type CliIO,
  COMMIT_OPTIONS,
  type CommandSpec,
  commitChoice,
  confirm,
} from "@nikovirtala/ledger/cli";
import { acceptDecision, type CopyScope, type ScopeOffer } from "../write.js";
import { displayAfterWrite, openForCli } from "./open.js";
import { writeText } from "./text.js";

const MAX_LISTED = 5;

/** `Copy the scope of ADR-0002 (src/a/**, src/b/**) to k3f9q8a1? [y/N] ` (design §6.10). */
function question(id: string, offer: ScopeOffer): string {
  const shown = offer.globs.slice(0, MAX_LISTED).join(", ");
  const more = offer.globs.length - MAX_LISTED;
  const globs = more > 0 ? `${shown} and ${more} more` : shown;
  const ds = offer.displays;
  const sources = ds.length === 1 ? ds[0] : `${ds.slice(0, -1).join(", ")} and ${ds.at(-1)}`;
  const list = ds.length === 1 ? globs : `${offer.globs.length} globs: ${globs}`;
  return `Copy the scope of ${sources} (${list}) to ${id}? [y/N] `;
}

/**
 * The flags decide; without them a person at a terminal is asked, and everyone else (scripts,
 * hooks, CI, `--json`) gets the note with the `adr scope` command (design §6.10, D-e). `seen`
 * receives the offer that was copied, for the text.
 */
function copyChoice(
  io: CliIO,
  json: boolean,
  value: unknown,
  seen: (offer: ScopeOffer) => void,
): CopyScope {
  const copy = async (offer: ScopeOffer) => {
    seen(offer);
    return true;
  };
  if (value === true) return copy;
  if (value === false) return "skip";
  if (json || !io.interactive) return "suggest";
  return async (offer) => {
    const yes = await confirm(io, question(offer.id, offer), { json });
    if (yes) seen(offer);
    return yes;
  };
}

/** `adr accept <decision> [--copy-scope | --no-copy-scope] …` (design §5.6, §6.10). */
export const acceptCommand: CommandSpec = {
  name: "accept",
  summary: "accept a proposed decision, superseding the decisions it declares",
  usage:
    "accept <decision> [--copy-scope | --no-copy-scope] [--commit | --no-commit] [-m <message>]",
  options: { "copy-scope": { type: "boolean" }, ...COMMIT_OPTIONS },
  positionals: { min: 1, max: 1, names: ["decision"] },
  ref: "reject",
  async run({ io, flags, values, positionals }) {
    const input = positionals[0] ?? "";
    const log = await openForCli(io, flags);
    const { actor, notes: attribution } = await resolveAttribution(log.git, { env: io.env });
    const seen: { offer: ScopeOffer | null } = { offer: null };
    const copyScope = copyChoice(io, flags.json, values["copy-scope"], (offer) => {
      seen.offer = offer;
    });
    const doc = await acceptDecision(
      log,
      { id: input, actor },
      {
        ...commitChoice(values, { autoCommit: log.adr.autoCommit }),
        notes: attribution,
        copyScope,
      },
    );
    const { display } = await displayAfterWrite(log);
    const v = doc.decision;
    return {
      exit: doc.ok ? 0 : 1,
      json: doc as unknown as JsonValue,
      text: writeText(doc, display, {
        subject: v === null ? input.trim() : `${display(v.id)}: ${v.title}`,
        number: v === null || doc.commit === null || v.number === null ? null : v.display,
        copied: doc.ok ? seen.offer : null,
      }),
      notes: doc.notes,
    };
  },
};
