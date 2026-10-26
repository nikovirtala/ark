import { UsageError } from "@nikovirtala/ledger";
import type { McpPrompt } from "@nikovirtala/ledger/mcp";
import { readDecisions, resolveDecision } from "../log.js";
import { listTemplates } from "../templates/list.js";
import { type AdrMcpEnv, openLog } from "./tools.js";

/**
 * `adr_draft_from_discussion` (design §7.8): the steps from a discussion to a proposal, with the
 * template's sections spelled out, ending with a human's `adr accept`.
 */
export function draftPrompt(e: AdrMcpEnv): McpPrompt {
  return {
    name: "adr_draft_from_discussion",
    title: "Draft a decision from the discussion",
    description:
      "Turn the current discussion into a proposed architecture decision, checking the existing ones first.",
    arguments: [
      { name: "title", description: "Working title of the decision", required: false },
      {
        name: "template",
        description: "Template name; default [log] default_template",
        required: false,
      },
      {
        name: "supersedes",
        description: "A decision this proposal replaces: id or number",
        required: false,
      },
    ],
    async get(args) {
      const read = await readDecisions(await openLog(e));
      const templates = await listTemplates(read);
      const name = args.template ?? templates.default;
      const t = templates.templates.find((x) => x.name === name);
      if (t === undefined)
        throw new UsageError(`unknown template ${name}; adr_templates lists them`);
      const replaced =
        args.supersedes === undefined ? null : resolveDecision(read, args.supersedes);
      const shown = (id: string) => {
        const display = read.projection.views.get(id)?.display ?? id;
        return display === id ? id : `${display} (${id})`;
      };
      const title =
        args.title === undefined
          ? 'a short title that states the decision, such as "Use PostgreSQL for orders"'
          : JSON.stringify(args.title);
      return [
        "Turn the current discussion into an architecture decision proposal with adr.",
        "",
        "1. Call adr_search with the main subject of the discussion, and adr_for_path for the files it concerns. If an accepted decision already covers this, tell the user which one, and ask whether the proposal should supersede it.",
        ...(replaced === null
          ? []
          : [
              `1a. The user named ${shown(replaced)} as the decision this replaces; read it with adr_get first.`,
            ]),
        `2. Use the template ${t.name} (version ${t.version}). Its sections:`,
        ...t.sections.map(
          (s) =>
            `   - ${s.id}: ${s.heading}, ${s.required ? "required" : "optional"}.${s.guidance === null ? "" : ` ${s.guidance}`}`,
        ),
        "3. Fill every required section with facts from the discussion and the code only. Where something wasn't settled, write it as an open question in that section instead of inventing an answer. If the template has an options section, list at least two options with their trade-offs, including those the discussion rejected.",
        `4. Call adr_propose with the title ${title}, template "${t.name}", the sections map${replaced === null ? "" : `, and supersedes ["${replaced}"]`}.`,
        "5. If the result has ok: true with findings, fix those sections with adr_update_draft and the new decision's id. If it was refused (ok: false), fill in every section the findings name and call adr_propose again.",
        "6. Don't accept the proposal. Tell the user its id, and that they can review it and run: adr accept <id>",
      ].join("\n");
    },
  };
}
