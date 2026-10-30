import { type JsonValue, type SetOp, UsageError } from "@nikovirtala/ledger";
import { type McpTool, type McpToolResult, mcpAttribution } from "@nikovirtala/ledger/mcp";
import { RELS } from "../kind/schemas.js";
import { type IssueLog, readIssues, resolveIssue } from "../log.js";
import {
  assignIssue,
  closeIssue,
  commentIssue,
  editIssue,
  type IssueWriteJson,
  labelIssue,
  linkIssue,
  openIssue,
  type SetIssueInput,
  scopeIssue,
  startIssue,
  stopIssue,
  unlinkIssue,
} from "../write.js";
import { type WriteTextOptions, writeText } from "./text.js";
import {
  ASSIGNEES,
  doc,
  GLOBS,
  ID,
  type IssuesMcpEnv,
  LABELS,
  object,
  openLog,
  REF,
  type Schema,
  SECTIONS,
  str,
  strings,
  TEXT,
  WRITE,
} from "./tools.js";

const TITLE = { type: "string", minLength: 1, maxLength: 200 } as const;

const sectionsOf = (v: JsonValue | undefined): Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? Object.fromEntries(
        Object.entries(v).flatMap(([k, x]) => (typeof x === "string" ? [[k, x]] : [])),
      )
    : {};

/** How the set tools' messages name `set`, `add`, `remove` and clearing: as their inputs. */
const MCP_NAMES = { set: "set", add: "add", remove: "remove", clear: "set: []" } as const;

/** The set operation of `set`, `add` and `remove`, as `cli/sets.ts` builds it from the flags. */
function setOp(input: Readonly<Record<string, JsonValue>>): SetOp {
  const set = strings(input.set);
  const add = strings(input.add);
  const remove = strings(input.remove);
  return {
    ...(set === undefined ? {} : { set }),
    ...(add === undefined ? {} : { add }),
    ...(remove === undefined ? {} : { remove }),
  };
}

/**
 * A write tool's result: the library's document, and its text rendered from a read of the log
 * after the write.
 */
async function writeResult(
  log: IssueLog,
  d: IssueWriteJson,
  o: Omit<WriteTextOptions, "read">,
): Promise<McpToolResult> {
  const read = await readIssues(log);
  return { document: doc(d), ...writeText(d, { ...o, read }) };
}

/**
 * The write tools `issues mcp` lists (design §7.2). Each records the MCP client as the agent,
 * acting for `ARK_ON_BEHALF_OF` or the git identity, and never passes `commit`, so `[policy]
 * auto_commit` decides whether the write commits (design §4.3).
 */
export function writeTools(e: IssuesMcpEnv): McpTool[] {
  return [
    {
      name: "issues_open",
      title: "Open an issue",
      description:
        "Open an issue: give the title and a sections map (section id → markdown) for the template (issues_templates lists them); the tool renders and stages the description. Search with issues_search first so you don't file a duplicate. Lint findings come back in findings: fix them with issues_update. With auto_commit on, an incomplete description is refused; send every required section.",
      inputSchema: object(
        {
          title: TITLE,
          template: { type: "string", pattern: "^[a-z][a-z0-9-]*$", maxLength: 64 },
          sections: SECTIONS,
          labels: LABELS(),
          parent: REF,
          depends_on: { type: "array", items: REF, maxItems: 50 },
        },
        ["title"],
      ),
      annotations: WRITE,
      async run(input, ctx) {
        const log = await openLog(e);
        const { actor, notes } = await mcpAttribution(log.git, ctx);
        const template = str(input.template);
        const parent = str(input.parent);
        const dependsOn = strings(input.depends_on);
        const labels = strings(input.labels);
        const d = await openIssue(
          log,
          {
            title: str(input.title) ?? "",
            sections: sectionsOf(input.sections),
            actor,
            ...(template === undefined ? {} : { template }),
            ...(parent === undefined ? {} : { parent }),
            ...(dependsOn === undefined ? {} : { dependsOn }),
            ...(labels === undefined ? {} : { labels }),
          },
          { notes },
        );
        return writeResult(log, d, { tool: "issues_open" });
      },
    },
    {
      name: "issues_update",
      title: "Update an issue's description",
      description:
        "Replace sections of an issue's description (section id → markdown), or its title, keeping every other line. Empty text removes an optional section; text adds it back in the template's order. Keep Done when accurate when the understanding of the work changes. Refused while the file has unstaged changes.",
      inputSchema: {
        ...object({ id: ID, title: TITLE, sections: { ...SECTIONS, minProperties: 1 } }, ["id"]),
        minProperties: 2,
      },
      inputHint: "issues_update needs id and a title or sections",
      annotations: WRITE,
      async run(input, ctx) {
        const log = await openLog(e);
        const { actor, notes } = await mcpAttribution(log.git, ctx);
        const read = await readIssues(log);
        const id = resolveIssue(read, str(input.id) ?? "");
        const path = read.projection.views.get(id)?.body_path ?? null;
        // An agent can't see a person's unsaved work in the file; don't stage it for them (D6).
        if (path !== null && (await log.git.unstagedPaths([path])).length > 0) {
          throw new UsageError(
            `${path} has unstaged changes; stage or discard them, or edit the description by hand`,
          );
        }
        const title = str(input.title);
        const sections = sectionsOf(input.sections);
        const d = await editIssue(
          log,
          { id, sections, actor, ...(title === undefined ? {} : { title }) },
          { notes, refuseIncomplete: log.issues.autoCommit },
        );
        return writeResult(log, d, {
          tool: "issues_update",
          sections: Object.keys(sections),
          title: title !== undefined,
        });
      },
    },
    {
      name: "issues_comment",
      title: "Comment on an issue",
      description:
        "Add a comment: progress, findings, decisions, or why an issue should be reopened.",
      inputSchema: object({ id: ID, text: TEXT }, ["id", "text"]),
      annotations: WRITE,
      async run(input, ctx) {
        const log = await openLog(e);
        const { actor, notes } = await mcpAttribution(log.git, ctx);
        const d = await commentIssue(
          log,
          { id: str(input.id) ?? "", text: str(input.text) ?? "", actor },
          { notes },
        );
        return writeResult(log, d, { tool: "issues_comment" });
      },
    },
    {
      name: "issues_start",
      title: "Start an issue",
      description:
        "Mark work begun; assigns the person you act for if the issue is unassigned. A BLOCKED issue can be started, with a warning; finish its blockers first.",
      inputSchema: object({ id: ID }, ["id"]),
      annotations: WRITE,
      async run(input, ctx) {
        const log = await openLog(e);
        const { actor, notes } = await mcpAttribution(log.git, ctx);
        const d = await startIssue(log, { id: str(input.id) ?? "", actor }, { notes });
        return writeResult(log, d, { tool: "issues_start" });
      },
    },
    {
      name: "issues_stop",
      title: "Stop work on an issue",
      description: "Pause work without finishing; say what is left in reason.",
      inputSchema: object({ id: ID, reason: TEXT }, ["id"]),
      annotations: WRITE,
      async run(input, ctx) {
        const log = await openLog(e);
        const { actor, notes } = await mcpAttribution(log.git, ctx);
        const d = await stopIssue(
          log,
          { id: str(input.id) ?? "", reason: str(input.reason) ?? null, actor },
          { notes },
        );
        return writeResult(log, d, { tool: "issues_stop" });
      },
    },
    {
      name: "issues_close",
      title: "Close an issue",
      description:
        "Close an issue whose Done when conditions are all met. resolution defaults to done; reason is required from agents and must say how each condition was met; duplicate needs of. Refused when the issue log's policy keeps closing to people. There is no reopen tool.",
      // `reason` is optional on purpose: the kind reports a missing one (issue/agent-reason-required).
      inputSchema: object(
        {
          id: ID,
          resolution: { type: "string", enum: ["done", "wontfix", "obsolete", "duplicate"] },
          reason: TEXT,
          of: ID,
        },
        ["id"],
      ),
      annotations: WRITE,
      async run(input, ctx) {
        const log = await openLog(e);
        const { actor, notes } = await mcpAttribution(log.git, ctx);
        const resolution = str(input.resolution) ?? null;
        const of = str(input.of) ?? null;
        // planClose's own messages name --resolution and --duplicate-of; catch those cases first.
        if (of !== null && resolution !== null && resolution !== "duplicate") {
          throw new UsageError("of needs resolution duplicate (or no resolution)");
        }
        if (of === null && resolution === "duplicate") {
          throw new UsageError("resolution duplicate needs of, the issue this one duplicates");
        }
        const d = await closeIssue(
          log,
          { id: str(input.id) ?? "", resolution, of, reason: str(input.reason) ?? null, actor },
          { notes },
        );
        return writeResult(log, d, { tool: "issues_close" });
      },
    },
    ...(["link", "unlink"] as const).map(
      (verb): McpTool => ({
        name: `issues_${verb}`,
        title: verb === "link" ? "Link an issue" : "Unlink an issue",
        description:
          verb === "link"
            ? "Record a relation: depends-on, part-of or relates-to another issue, or implements a decision (adr:<id> or ADR-0012)."
            : "Remove a relation; the stored target always works.",
        inputSchema: object({ id: ID, to: REF, rel: { type: "string", enum: [...RELS] } }, [
          "id",
          "to",
        ]),
        annotations: WRITE,
        async run(input, ctx) {
          const log = await openLog(e);
          const { actor, notes } = await mcpAttribution(log.git, ctx);
          const to = str(input.to) ?? "";
          const rel = str(input.rel) ?? "relates-to";
          const f = verb === "link" ? linkIssue : unlinkIssue;
          const d = await f(log, { id: str(input.id) ?? "", to, rel, actor }, { notes });
          return writeResult(log, d, { tool: `issues_${verb}`, rel, to });
        },
      }),
    ),
    setTool(e, {
      name: "issues_label",
      title: "Label an issue",
      description:
        "Set, add or remove labels; a label of an exclusive prefix replaces the current one.",
      items: LABELS(),
      write: labelIssue,
    }),
    setTool(e, {
      name: "issues_assign",
      title: "Assign an issue",
      description: "Set, add or remove assignees; me is the person you act for.",
      items: ASSIGNEES,
      write: assignIssue,
    }),
    setTool(e, {
      name: "issues_scope",
      title: "Scope an issue",
      description:
        "Set, add or remove the globs that tie the issue to code. An open issue may name files that don't exist yet; once started, every glob must match a tracked file.",
      items: GLOBS,
      write: scopeIssue,
    }),
  ];
}

/** `issues_label`, `issues_assign` and `issues_scope`: `set`, or `add` and `remove`, of `items`. */
function setTool(
  e: IssuesMcpEnv,
  t: {
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly items: Schema;
    readonly write: (
      log: IssueLog,
      input: SetIssueInput,
      o: { readonly notes: readonly string[] },
    ) => Promise<IssueWriteJson>;
  },
): McpTool {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: {
      ...object({ id: ID, set: t.items, add: t.items, remove: t.items }, ["id"]),
      minProperties: 2,
    },
    inputHint: `${t.name} needs id and at least one of set, add or remove`,
    annotations: WRITE,
    async run(input, ctx) {
      const log = await openLog(e);
      const { actor, notes } = await mcpAttribution(log.git, ctx);
      const d = await t.write(
        log,
        { id: str(input.id) ?? "", op: setOp(input), actor, names: MCP_NAMES },
        { notes },
      );
      return writeResult(log, d, { tool: t.name });
    },
  };
}
