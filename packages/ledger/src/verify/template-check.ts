import { type Finding, finding } from "../findings/finding.js";
import type { Git } from "../git/git.js";
import { isKind } from "../kind/define.js";
import { loadTemplates } from "../templates/history.js";
import { lintDocument, lintTemplate } from "../templates/lint.js";
import type { TemplateSourceFactory } from "../templates/source.js";
import type { Check } from "./checks.js";
import type { VerifyMode } from "./verify.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

function decode(bytes: Uint8Array): string | null {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The ref whose history holds older template versions for a verify run: the mode's head ref when
 * set, else `"HEAD"` (work tree and index heads), else `null` when `HEAD` is unborn.
 */
export async function templateHistoryRef(git: Git, mode: VerifyMode): Promise<string | null> {
  if (mode.type !== "staged" && mode.head !== undefined) return mode.head;
  return (await git.resolveCommit("HEAD")) === null ? null : "HEAD";
}

/**
 * Template lint for a defined kind with `templates`. Bodies of in-scope subjects whose status is in
 * `lintIn` are linted against the template their initial event names, as are bodies whose applied
 * `lintOn` event is new against a base. The template files themselves get syntax lint: all of
 * them in scope `all`, the changed ones in scope `changed`. `null` turns the check off.
 */
export function templateCheck(templates: TemplateSourceFactory | null): Check {
  return {
    id: "template",
    async run(ctx) {
      const folded = ctx.folded ?? null;
      const kind = ctx.kind.kind;
      if (templates === null || folded === null || !isKind(kind)) return [];
      const t = kind.def.templates;
      if (t === undefined) return [];
      const dir = `${ctx.layout.root}/${t.dir.replace(/\/+$/, "")}`;
      const source = templates(ctx.head.tree, dir);
      const added = new Set(ctx.changes.filter((c) => c.status === "added").map((c) => c.path));
      const lintIn = new Set<string>(t.lintIn);
      const out: Finding[] = [];

      for (const id of [...ctx.inScope].sort()) {
        const s = folded.head.subjects.get(id);
        const body = s?.loaded.body ?? null;
        if (s === undefined || s.status === null || body === null) continue;
        const newlyOn =
          t.lintOn !== undefined &&
          ctx.base !== null &&
          s.applied.some((a) => a.event.type === t.lintOn && added.has(a.path));
        if (!lintIn.has(s.status) && !newlyOn) continue;
        const error = (rule: string, message: string) =>
          finding({ severity: "error", rule, message, file: body.path, subject: id });
        const data = s.applied[0]?.event.data as Readonly<Record<string, unknown>> | undefined;
        const name = data?.[t.nameField];
        const version = data?.[t.versionField];
        if (typeof name !== "string") {
          out.push(error("template/not-found", `the initial event names no template`));
          continue;
        }
        if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
          out.push(
            error("template/version-not-found", `the initial event names no version of ${name}`),
          );
          continue;
        }
        const found = await source.get(name, version);
        if (!found.ok) {
          out.push(
            found.reason === "not-found"
              ? error("template/not-found", `template ${name} not found at ${found.path}`)
              : error(
                  "template/version-not-found",
                  `template ${name} has no version ${version} at ${found.path}`,
                ),
          );
          continue;
        }
        const text = decode(body.bytes);
        if (text === null) {
          out.push(error("body/not-utf8", "body is not valid UTF-8"));
          continue;
        }
        out.push(...lintDocument(found.template, text, { file: body.path, subject: id }));
      }

      const changed = new Set(ctx.changes.filter((c) => c.status !== "deleted").map((c) => c.path));
      const wanted = (file: string | null) =>
        ctx.scope === "all" || (file !== null && changed.has(file));
      const loaded = await loadTemplates(ctx.head.tree, dir);
      const seen = new Set<Finding>(loaded.findings);
      out.push(...loaded.findings.filter((f) => wanted(f.file)));
      const requireSections = t.requireSections ?? [];
      for (const template of loaded.templates.values()) {
        if (!wanted(template.path)) continue;
        // lintTemplate repeats the parse's syntax findings; keep only the ones not reported yet.
        for (const f of lintTemplate(template, { requireSections })) if (!seen.has(f)) out.push(f);
      }
      return out;
    },
  };
}
