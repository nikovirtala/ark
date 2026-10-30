import { UsageError } from "@nikovirtala/ledger";
import type { McpPrompt } from "@nikovirtala/ledger/mcp";
import { type IssuesRead, readIssues, resolveIssue } from "../log.js";
import { type IssueTemplatesJson, listTemplates } from "../templates/list.js";
import { mcpHeader } from "./text.js";
import { type IssuesMcpEnv, openLog } from "./tools.js";

type ListedTemplate = IssueTemplatesJson["templates"][number];

/** The log and its templates, read afresh for one `get` (design D2). */
async function readLog(e: IssuesMcpEnv) {
  const read = await readIssues(await openLog(e));
  return { read, templates: await listTemplates(read) };
}

/** The template `name` names, or the default one; an unknown name is a usage error (−32602). */
function templateFor(templates: IssueTemplatesJson, name: string | undefined): ListedTemplate {
  const wanted = name ?? templates.default;
  const t = templates.templates.find((x) => x.name === wanted);
  if (t === undefined)
    throw new UsageError(`unknown template ${wanted}; issues_templates lists them`);
  return t;
}

/** `<display> (<id>)`, or the id when the issue has no number. */
function named(read: IssuesRead, id: string): string {
  const display = read.projection.views.get(id)?.display ?? id;
  return display === id ? id : `${display} (${id})`;
}

/** One line per section: id, heading, whether it is required, and its guidance. */
const sectionLines = (t: ListedTemplate) =>
  t.sections.map(
    (s) =>
      `   - ${s.id}: ${s.heading}, ${s.required ? "required" : "optional"}.${s.guidance === null ? "" : ` ${s.guidance}`}`,
  );

/** The section open questions go in: `notes`, else the first optional section, else the first. */
function notesHeading(t: ListedTemplate): string {
  const s =
    t.sections.find((x) => x.id === "notes") ??
    t.sections.find((x) => !x.required) ??
    t.sections[0];
  return s?.heading ?? "Notes";
}

/**
 * `issues_from_discussion` (design §8.1): the steps from a discussion to one issue, checking for
 * an existing one first, with the template's sections spelled out.
 */
export function fromDiscussionPrompt(e: IssuesMcpEnv): McpPrompt {
  return {
    name: "issues_from_discussion",
    title: "Open an issue from the discussion",
    description:
      "Turn the current conversation into one issue, filling the template's sections and listing open questions, after checking for an existing issue.",
    arguments: [
      { name: "title", description: "Working title of the issue", required: false },
      {
        name: "template",
        description: "Template name; default [log] default_template",
        required: false,
      },
      {
        name: "parent",
        description: "An issue this one is part of: id or number",
        required: false,
      },
    ],
    async get(args) {
      const { read, templates } = await readLog(e);
      const t = templateFor(templates, args.template);
      const parent = args.parent === undefined ? null : resolveIssue(read, args.parent);
      const title =
        args.title === undefined
          ? 'a short imperative title, such as "Fix the session cookie on Safari"'
          : JSON.stringify(args.title);
      return [
        "Turn the current discussion into one issue with issues.",
        "",
        "1. Call issues_search with the main subject of the discussion (include_closed: true), and issues_for_path for the files it concerns. If an open issue already tracks this, tell the user which one and add what is new to it with issues_comment instead of opening another. If a closed one does, tell the user and ask whether it should be reopened.",
        ...(parent === null
          ? []
          : [
              `1a. The new issue is part of ${named(read, parent)}; read it with issues_get first.`,
            ]),
        `2. Use the template ${t.name} (version ${t.version}). Its sections:`,
        ...sectionLines(t),
        `3. Fill every required section with facts from the discussion and the code only. Write Done when as conditions someone else can check. List what wasn't settled as open questions in the ${notesHeading(t)} section instead of inventing answers.`,
        `4. Call issues_open with the title ${title}, template "${t.name}", the sections map${parent === null ? "" : `, and parent "${parent}"`}. Add labels only when the discussion names them.`,
        "5. If the result has ok: true with findings, fix those sections with issues_update and the new issue's id. If it was refused (ok: false), fill in every section the findings name and call issues_open again.",
        "6. Tell the user the new issue's number or id, and its open questions. Don't start it unless the user asks.",
      ].join("\n");
    },
  };
}

/**
 * `issues_breakdown` (design §8.1): splitting an issue into children linked with `part-of`, with
 * the issue's state header and its current children, after the user agrees.
 */
export function breakdownPrompt(e: IssuesMcpEnv): McpPrompt {
  return {
    name: "issues_breakdown",
    title: "Break an issue down",
    description:
      "Split a large issue into child issues linked with part-of, with depends-on between them where order matters.",
    arguments: [
      { name: "id", description: "The issue to break down: id or number", required: true },
      {
        name: "template",
        description: "Template for the children; default [log] default_template",
        required: false,
      },
    ],
    async get(args) {
      const { read, templates } = await readLog(e);
      const id = resolveIssue(read, args.id ?? "");
      const t = templateFor(templates, args.template);
      const view = read.projection.views.get(id);
      if (view === undefined) throw new UsageError(`unknown issue ${args.id}`);
      const header = mcpHeader(view, read);
      const who = named(read, id);
      const children =
        view.children.length === 0 ? "none" : view.children.map((c) => named(read, c)).join(", ");
      return [
        `Break ${who} down into child issues with issues.`,
        "",
        header.line,
        ...(header.warning === null ? [] : [header.warning]),
        "",
        `1. Read ${who} with issues_get. If its header says DUPLICATE, break down the canonical issue instead; if it is closed, ask the user first. Its children so far: ${children}.`,
        `2. Split the work into children that can each be finished and reviewed on its own. Together, their Done when conditions must cover every condition in ${view.display}'s Done when, and each child's must be checkable on its own. Write down which child covers which condition.`,
        "3. Show the user the children (title, one-line goal, order) and the mapping, and wait for their agreement before opening any.",
        `4. Open the children in order with issues_open, template "${t.name}", parent "${id}", and depends_on naming the earlier children (by the ids issues_open returned) that must be finished first. Fill every required section.`,
        "5. If a result has findings, fix those sections with issues_update.",
        `6. Don't close or edit ${view.display} itself: it is finished when its children are. Tell the user the children's ids.`,
      ].join("\n");
    },
  };
}

/** The prompts `issues mcp` serves, in the order it lists them. */
export const issuesPrompts = (e: IssuesMcpEnv): McpPrompt[] => [
  fromDiscussionPrompt(e),
  breakdownPrompt(e),
];
