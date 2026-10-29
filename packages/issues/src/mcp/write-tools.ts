import { type JsonValue, UsageError } from "@nikovirtala/ledger";
import { type McpTool, type McpToolResult, mcpAttribution } from "@nikovirtala/ledger/mcp";
import { type IssueLog, readIssues, resolveIssue } from "../log.js";
import {
  closeIssue,
  commentIssue,
  editIssue,
  type IssueWriteJson,
  openIssue,
  startIssue,
  stopIssue,
} from "../write.js";
import { type WriteTextOptions, writeText } from "./text.js";
import {
  doc,
  ID,
  type IssuesMcpEnv,
  LABELS,
  object,
  openLog,
  REF,
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
        "Replace sections of an issue's description (section id → markdown), or its title, keeping every other line. Keep Done when accurate when the understanding of the work changes. Refused while the file has unstaged changes.",
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
  ];
}
