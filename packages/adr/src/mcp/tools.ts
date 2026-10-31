import {
  type Attribution,
  eventDir,
  type JsonValue,
  MAX_GLOB_LENGTH,
  SOURCE_NAME,
  UsageError,
} from "@nikovirtala/ledger";
import { type McpTool, type McpToolResult, mcpAttribution } from "@nikovirtala/ledger/mcp";
import { DECISION_STATUSES, type DecisionStatus } from "../kind.js";
import {
  type DecisionLog,
  type DecisionsRead,
  openDecisionLog,
  readDecisions,
  resolveDecision,
} from "../log.js";
import { decisionsFor } from "../scope.js";
import { searchDecisions } from "../search.js";
import { readSourceDecisions } from "../sources.js";
import { listTemplates } from "../templates/list.js";
import { listDecisions, showDecision } from "../views.js";
import {
  acceptDecision,
  deprecateDecision,
  linkDecision,
  noteDecision,
  proposeDecision,
  rejectDecision,
  scopeDecision,
  supersedeDecision,
  updateDraft,
  type WriteResultJson,
  withdrawDecision,
} from "../write.js";
import { mcpWriteRefusal, type PolicyTool, proposalOwner } from "./policy.js";
import {
  forText,
  getText,
  listText,
  searchText,
  templatesText,
  type WriteTextOptions,
  writeText,
} from "./text.js";

/** Where `adr mcp` runs: every call opens the log afresh from here (design D2). */
export interface AdrMcpEnv {
  readonly cwd: string;
  readonly root: string | null;
  readonly env: NodeJS.ProcessEnv;
}

type Schema = Readonly<Record<string, JsonValue>>;

export const ID: Schema = { type: "string", minLength: 1, maxLength: 64 };
const TEXT: Schema = { type: "string", minLength: 1, maxLength: 65_536 };
const SECTIONS: Schema = {
  type: "object",
  propertyNames: { type: "string", pattern: "^[a-z][a-z0-9-]*$", maxLength: 64 },
  additionalProperties: { type: "string", maxLength: 65_536 },
  maxProperties: 50,
};
const GLOBS: Schema = {
  type: "array",
  items: { type: "string", minLength: 1, maxLength: MAX_GLOB_LENGTH },
  maxItems: 200,
};

const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: "object",
  properties,
  ...(required.length === 0 ? {} : { required }),
  additionalProperties: false,
});

export const READ = { readOnlyHint: true, openWorldHint: false } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

/** The log for one call, opened again so outside edits and `[policy]` changes are seen. */
export const openLog = (e: AdrMcpEnv, ref: string | null = null): Promise<DecisionLog> =>
  openDecisionLog({ cwd: e.cwd, root: e.root, ref, gitOptions: { env: e.env } });

const str = (v: JsonValue | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;
const strings = (v: JsonValue | undefined): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
const sectionsOf = (v: JsonValue | undefined): Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? Object.fromEntries(
        Object.entries(v).flatMap(([k, x]) => (typeof x === "string" ? [[k, x]] : [])),
      )
    : {};

const doc = (d: unknown): JsonValue => d as JsonValue;

/**
 * A write tool's result: the library's document, and its text rendered from a read of the log
 * after the write.
 */
async function writeResult(
  log: DecisionLog,
  d: WriteResultJson,
  o: Omit<WriteTextOptions, "read">,
): Promise<McpToolResult> {
  const read = await readDecisions(log);
  return { document: doc(d), ...writeText(d, { ...o, read }) };
}

/** The `adr-write/v1` command of each policy tool, as the CLI names it. */
const COMMAND: Record<PolicyTool, WriteResultJson["command"]> = {
  adr_scope: "scope",
  adr_update_draft: "update",
  adr_withdraw: "withdraw",
};

/**
 * The MCP policy step of `adr_scope`, `adr_update_draft` and `adr_withdraw` (design §7.5): the refusal document
 * when the agent may not make this write, else `null`.
 */
function policyRefusal(
  log: DecisionLog,
  read: DecisionsRead,
  tool: PolicyTool,
  id: string,
  attribution: Attribution,
): WriteResultJson | null {
  const view = read.projection.views.get(id);
  if (view === undefined) return null;
  const finding = mcpWriteRefusal({
    tool,
    view,
    owner: proposalOwner(read, id),
    actor: attribution.actor,
    mcpCanDecide: log.adr.mcpCanDecide,
    display: (x) => read.projection.views.get(x)?.display ?? x,
    eventsDir: eventDir(read.layout, id),
  });
  if (finding === null) return null;
  return {
    format: "adr-write/v1",
    command: COMMAND[tool],
    ok: false,
    decision: view,
    affected: [],
    written: [],
    commit: null,
    findings: [finding],
    notes: [...log.notes, ...attribution.notes],
  };
}

/** The `source` input of `adr_list` and `adr_search`: a `[[sources]]` name, read from the cache. */
const SOURCE = { type: "string", pattern: `^${SOURCE_NAME}$` } as const;

/** The local log, or with `source` that `[[sources]]` entry's cached log. */
async function readFor(e: AdrMcpEnv, source: string | null) {
  const log = await openLog(e);
  return source === null ? readDecisions(log) : readSourceDecisions(log, source);
}

/** The eleven tools `adr mcp` always lists (design §7.4). */
export function alwaysOnTools(e: AdrMcpEnv): McpTool[] {
  return [
    {
      name: "adr_search",
      title: "Search decisions",
      description:
        "Full-text search of the decision log: every word must appear in a decision's id, title, body or notes. Returns active (proposed or accepted) decisions unless include_inactive is true, each with its state header and an excerpt.",
      inputSchema: object(
        {
          query: { type: "string", minLength: 1, maxLength: 200 },
          include_inactive: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          source: SOURCE,
        },
        ["query"],
      ),
      annotations: READ,
      async run(input) {
        const read = await readFor(e, str(input.source) ?? null);
        const d = searchDecisions(read, {
          query: str(input.query) ?? "",
          includeInactive: input.include_inactive === true,
          limit: typeof input.limit === "number" ? input.limit : 10,
        });
        return { document: doc(d), ...searchText(d, read) };
      },
    },
    {
      name: "adr_get",
      title: "Get a decision",
      description:
        "One decision with its state header, computed status, supersession chain, effective decision and body. Use this or adr://decision/{id} instead of reading files under docs/adr. A SUPERSEDED or DEPRECATED header means: don't apply it, follow the warning.",
      inputSchema: object(
        {
          id: ID,
          include_history: { type: "boolean" },
          ref: { type: "string", minLength: 1, maxLength: 256 },
        },
        ["id"],
      ),
      annotations: READ,
      async run(input) {
        const read = await readDecisions(await openLog(e, str(input.ref) ?? null));
        const id = resolveDecision(read, str(input.id) ?? "");
        const d = await showDecision(read, id, { history: input.include_history === true });
        return { document: doc(d), ...getText(d, read) };
      },
    },
    {
      name: "adr_list",
      title: "List decisions",
      description:
        "All decisions with their computed status, for orientation. Filter by status; limit truncates.",
      inputSchema: object({
        status: {
          type: "array",
          items: { type: "string", enum: [...DECISION_STATUSES] },
          uniqueItems: true,
          minItems: 1,
          maxItems: DECISION_STATUSES.length,
        },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        source: SOURCE,
      }),
      annotations: READ,
      async run(input) {
        const read = await readFor(e, str(input.source) ?? null);
        const status = strings(input.status) as DecisionStatus[] | undefined;
        const d = listDecisions(read, {
          ...(status === undefined ? {} : { status }),
          ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
        });
        return { document: doc(d), ...listText(d, read) };
      },
    },
    {
      name: "adr_templates",
      title: "List templates",
      description:
        "The templates adr_propose can use, with each section's id, heading, whether it is required, and guidance for filling it in.",
      inputSchema: object({}),
      annotations: READ,
      async run() {
        const d = await listTemplates(await readDecisions(await openLog(e)));
        return { document: doc(d), ...templatesText(d) };
      },
    },
    {
      name: "adr_propose",
      title: "Propose a decision",
      description:
        "Propose a decision: give the title and a sections map (section id → markdown) for the template; the tool renders and stages the draft. Lint findings come back in findings: fix them with adr_update_draft. With auto_commit on, an incomplete draft is refused; send every required section. You can't accept your own proposal; tell the user its id.",
      inputSchema: object(
        {
          title: { type: "string", minLength: 1, maxLength: 200 },
          template: { type: "string", pattern: "^[a-z][a-z0-9-]*$", maxLength: 64 },
          sections: SECTIONS,
          supersedes: { type: "array", items: ID, maxItems: 20 },
        },
        ["title"],
      ),
      annotations: WRITE,
      async run(input, ctx) {
        const log = await openLog(e);
        const { actor, notes } = await mcpAttribution(log.git, ctx);
        const template = str(input.template);
        const supersedes = strings(input.supersedes);
        const d = await proposeDecision(
          log,
          {
            title: str(input.title) ?? "",
            sections: sectionsOf(input.sections),
            actor,
            ...(template === undefined ? {} : { template }),
            ...(supersedes === undefined ? {} : { supersedes }),
          },
          { notes },
        );
        return writeResult(log, d, {
          tool: "adr_propose",
          acceptRequiresHuman: log.adr.acceptRequiresHuman,
        });
      },
    },
    {
      name: "adr_update_draft",
      title: "Update a draft",
      description:
        "Replace sections of a proposed decision's draft (section id → markdown). Only your own proposals unless mcp_can_decide is on. Returns the lint result. With auto_commit on, an incomplete draft is refused; send every required section.",
      inputSchema: object({ id: ID, sections: { ...SECTIONS, minProperties: 1 } }, [
        "id",
        "sections",
      ]),
      annotations: WRITE,
      async run(input, ctx) {
        const log = await openLog(e);
        const read = await readDecisions(log);
        const id = resolveDecision(read, str(input.id) ?? "");
        const attribution = await mcpAttribution(log.git, ctx);
        const sections = sectionsOf(input.sections);
        const o = { tool: "adr_update_draft", sections: Object.keys(sections) };
        const refused = policyRefusal(log, read, "adr_update_draft", id, attribution);
        if (refused !== null) return writeResult(log, refused, o);
        const d = await updateDraft(log, { id, sections }, { notes: attribution.notes });
        return writeResult(log, d, o);
      },
    },
    {
      name: "adr_note",
      title: "Note on a decision",
      description:
        "Add a note to a decision in any state. Notes clarify; a changed decision needs a superseding proposal.",
      inputSchema: object({ id: ID, text: TEXT }, ["id", "text"]),
      annotations: WRITE,
      async run(input, ctx) {
        const log = await openLog(e);
        const { actor, notes } = await mcpAttribution(log.git, ctx);
        const d = await noteDecision(
          log,
          { id: str(input.id) ?? "", text: str(input.text) ?? "", actor },
          { notes },
        );
        return writeResult(log, d, { tool: "adr_note" });
      },
    },
    {
      name: "adr_link",
      title: "Link decisions",
      description:
        "Record a relation (relates-to, refines, depends-on) from one decision to another.",
      inputSchema: object(
        {
          id: ID,
          to: { type: "string", minLength: 1, maxLength: 100 },
          rel: { type: "string", enum: ["relates-to", "refines", "depends-on"] },
        },
        ["id", "to"],
      ),
      annotations: WRITE,
      async run(input, ctx) {
        const log = await openLog(e);
        const { actor, notes } = await mcpAttribution(log.git, ctx);
        const rel = str(input.rel);
        const d = await linkDecision(
          log,
          {
            id: str(input.id) ?? "",
            to: str(input.to) ?? "",
            actor,
            ...(rel === undefined ? {} : { rel }),
          },
          { notes },
        );
        return writeResult(log, d, { tool: "adr_link" });
      },
    },
    {
      name: "adr_for_path",
      title: "Decisions for paths",
      description:
        "The decisions that govern each file, from scope globs and code anchors. Inactive ones carry a warning.",
      inputSchema: object(
        {
          paths: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 4096 },
            minItems: 1,
            maxItems: 100,
          },
        },
        ["paths"],
      ),
      annotations: READ,
      async run(input) {
        const log = await openLog(e);
        const read = await readDecisions(log);
        const d = await decisionsFor(read, log, { paths: strings(input.paths) ?? [] });
        return { document: doc(d), ...forText(d, read) };
      },
    },
    {
      name: "adr_scope",
      title: "Scope a decision",
      description:
        "Set, add or remove the globs that map a decision to code. Allowed on your own proposals; rescoping someone else's proposal or an accepted or deprecated decision needs mcp_can_decide. If the decision's Scope section would no longer read true, propose a superseding decision instead.",
      inputSchema: {
        ...object({ id: ID, set: GLOBS, add: GLOBS, remove: GLOBS }, ["id"]),
        minProperties: 2,
      },
      inputHint: "adr_scope needs id and at least one of set, add or remove",
      annotations: WRITE,
      async run(input, ctx) {
        const log = await openLog(e);
        const read = await readDecisions(log);
        const id = resolveDecision(read, str(input.id) ?? "");
        const attribution = await mcpAttribution(log.git, ctx);
        const scopeBefore = read.projection.views.get(id)?.applies_to ?? [];
        const o = { tool: "adr_scope", scopeBefore };
        const refused = policyRefusal(log, read, "adr_scope", id, attribution);
        if (refused !== null) return writeResult(log, refused, o);
        const set = strings(input.set);
        const op = {
          ...(set === undefined ? {} : { set }),
          add: strings(input.add) ?? [],
          remove: strings(input.remove) ?? [],
        };
        const d = await scopeDecision(
          log,
          { id, op, actor: attribution.actor },
          { notes: attribution.notes },
        );
        return writeResult(log, d, o);
      },
    },
    {
      name: "adr_withdraw",
      title: "Withdraw a proposal",
      description:
        "Withdraw a proposed decision, with an optional reason, for example your own proposal when the user decides against it. Withdrawing someone else's proposal needs mcp_can_decide. Only proposals can be withdrawn; an accepted decision needs a superseding proposal.",
      inputSchema: object({ id: ID, reason: TEXT }, ["id"]),
      annotations: WRITE,
      async run(input, ctx) {
        const log = await openLog(e);
        const read = await readDecisions(log);
        const id = resolveDecision(read, str(input.id) ?? "");
        const attribution = await mcpAttribution(log.git, ctx);
        const o = { tool: "adr_withdraw" };
        const refused = policyRefusal(log, read, "adr_withdraw", id, attribution);
        if (refused !== null) return writeResult(log, refused, o);
        const d = await withdrawDecision(
          log,
          { id, reason: str(input.reason) ?? null, actor: attribution.actor },
          { notes: attribution.notes },
        );
        return writeResult(log, d, o);
      },
    },
  ];
}

/**
 * The log for a decision tool's call. The tool list was fixed at startup, so a call after
 * `mcp_can_decide` was turned off is a usage error telling the user to restart (design §7.3).
 */
async function decidingLog(e: AdrMcpEnv): Promise<DecisionLog> {
  const log = await openLog(e);
  if (!log.adr.mcpCanDecide) {
    throw new UsageError(
      `[policy] mcp_can_decide is now false in ${log.configPath ?? "adr.toml (not present)"}; restart adr mcp to update its tool list`,
    );
  }
  return log;
}

/** The four tools `adr mcp` lists only with `[policy] mcp_can_decide = true` (design §7.4). */
export function decisionTools(e: AdrMcpEnv): McpTool[] {
  return [
    {
      name: "adr_accept",
      title: "Accept a decision",
      description:
        "Accept a proposed decision (lints it, freezes the body, supersedes what it declares). Refused for agents while accept_requires_human is on.",
      inputSchema: object({ id: ID, copy_scope: { type: "boolean" } }, ["id"]),
      annotations: WRITE,
      async run(input, ctx) {
        const log = await decidingLog(e);
        const { actor, notes } = await mcpAttribution(log.git, ctx);
        const copyScope =
          input.copy_scope === true ? "copy" : input.copy_scope === false ? "skip" : "suggest";
        const d = await acceptDecision(
          log,
          { id: str(input.id) ?? "", actor },
          { notes, copyScope },
        );
        return writeResult(log, d, { tool: "adr_accept" });
      },
    },
    {
      name: "adr_reject",
      title: "Reject a decision",
      description: "Reject a proposed decision, with a reason.",
      inputSchema: object({ id: ID, reason: TEXT }, ["id", "reason"]),
      annotations: WRITE,
      async run(input, ctx) {
        const log = await decidingLog(e);
        const { actor, notes } = await mcpAttribution(log.git, ctx);
        const d = await rejectDecision(
          log,
          { id: str(input.id) ?? "", reason: str(input.reason) ?? "", actor },
          { notes },
        );
        return writeResult(log, d, { tool: "adr_reject" });
      },
    },
    {
      name: "adr_deprecate",
      title: "Deprecate a decision",
      description: "Deprecate an accepted decision that nothing replaces, with a reason.",
      inputSchema: object({ id: ID, reason: TEXT }, ["id", "reason"]),
      annotations: WRITE,
      async run(input, ctx) {
        const log = await decidingLog(e);
        const { actor, notes } = await mcpAttribution(log.git, ctx);
        const d = await deprecateDecision(
          log,
          { id: str(input.id) ?? "", reason: str(input.reason) ?? "", actor },
          { notes },
        );
        return writeResult(log, d, { tool: "adr_deprecate" });
      },
    },
    {
      name: "adr_supersede",
      title: "Supersede a decision",
      description: "Mark an accepted or deprecated decision superseded by an accepted one.",
      inputSchema: object({ id: ID, by: ID, reason: TEXT }, ["id", "by"]),
      annotations: WRITE,
      async run(input, ctx) {
        const log = await decidingLog(e);
        const { actor, notes } = await mcpAttribution(log.git, ctx);
        const reason = str(input.reason);
        const d = await supersedeDecision(
          log,
          {
            id: str(input.id) ?? "",
            by: str(input.by) ?? "",
            actor,
            ...(reason === undefined ? {} : { reason }),
          },
          { notes },
        );
        return writeResult(log, d, { tool: "adr_supersede" });
      },
    },
  ];
}
