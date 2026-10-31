import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Finding } from "../findings/finding.js";
import { parseTemplate, type Template } from "../templates/parse.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { type DriverPlan, type EditorStepOptions, editorStep } from "./write-driver.js";

const BODY = "log/items/bbbbbbbb.md";
const TEMPLATE = "log/templates/lite.md";
const OTHER = "src/other.ts";
const TEMPLATE_TEXT = `---
template: lite
version: 1
sections:
  - id: context
    heading: Context
    required: true
---
# {{title}}

## Context
{{context}}
`;
const UNFILLED = "# Gear\n\n## Context\n\n";
const FILLED = "# Gear\n\n## Context\nThe forces.\n";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function template(): Template {
  const r = parseTemplate(TEMPLATE_TEXT);
  if (!r.ok) throw new Error("expected a template");
  return r.template;
}

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});

/** A repo with the template and another file committed, and the draft staged as rendered. */
async function setup(rendered = UNFILLED): Promise<{ r: TempRepo; plan: DriverPlan }> {
  const r = await createTempRepo({ files: { [TEMPLATE]: TEMPLATE_TEXT, [OTHER]: "x\n" } });
  repos.push(r);
  await r.write(BODY, rendered);
  await r.stage(BODY);
  const plan: DriverPlan = {
    subject: "bbbbbbbb",
    files: {},
    events: [],
    stage: [BODY],
    commitScope: [BODY, TEMPLATE],
    eventDirs: [],
    trailers: [],
    findings: [],
    commit: null,
    draft: { path: BODY, rendered: encoder.encode(rendered), template: template() },
  };
  return { r, plan };
}

const out = async (r: TempRepo, args: string[]) => decoder.decode((await r.git.run(args)).stdout);
const stagedBody = (r: TempRepo) => out(r, ["show", `:${BODY}`]);

/**
 * Runs the step with an editor that does `change` to the body (and other files) and exits with
 * `exit` (`null`: 0), collecting the notes.
 */
async function step(
  r: TempRepo,
  plan: DriverPlan,
  o: {
    readonly change?: (abs: string) => Promise<void>;
    readonly exit?: string | null;
    readonly commitRequested?: boolean;
    readonly scope?: readonly string[];
    readonly extra?: Partial<EditorStepOptions>;
  } = {},
) {
  const notes: string[] = [];
  const edited: string[] = [];
  const run = editorStep({
    git: r.git,
    edit: async (abs) => {
      edited.push(abs);
      await o.change?.(abs);
      return o.exit ?? null;
    },
    onNote: (n) => notes.push(n),
    ...o.extra,
  });
  const after = await run(plan, o.commitRequested ?? true)(o.scope ?? plan.commitScope);
  return { after, notes, edited };
}
const fill = (abs: string) => writeFile(abs, FILLED);
const rules = (findings: readonly Finding[] | null) => findings?.map((f) => f.rule) ?? null;

describe("editorStep", () => {
  it("keeps the findings and the commit of a plan without a draft, without an editor", async () => {
    const { r, plan } = await setup();
    const { after, edited } = await step(r, { ...plan, draft: null });
    expect(after).toEqual({ findings: null, commit: true });
    expect(edited).toEqual([]);
  });

  it("re-stages the body the editor saved and commits a filled draft", async () => {
    const { r, plan } = await setup();
    const { after, notes, edited } = await step(r, plan, { change: fill });
    expect(edited).toEqual([join(r.root, BODY)]);
    expect(after).toEqual({ findings: [], commit: true });
    expect(notes).toEqual([]);
    expect(await stagedBody(r)).toBe(FILLED);
  });

  it("never commits a draft with unfilled required sections, noting it only for a commit", async () => {
    const { r, plan } = await setup();
    const committing = await step(r, plan);
    expect(committing.after.commit).toBe(false);
    expect(rules(committing.after.findings)).toEqual(["template/section-empty"]);
    expect(committing.notes).toEqual([
      `${BODY} still has unfilled required sections; fill them in, then commit`,
    ]);
    const staging = await step(r, plan, { commitRequested: false });
    expect(staging.after.commit).toBe(true);
    expect(rules(staging.after.findings)).toEqual(["template/section-empty"]);
    expect(staging.notes).toEqual([]);
  });

  it("maps each lint finding with finding", async () => {
    const { r, plan } = await setup();
    const { after } = await step(r, plan, {
      commitRequested: false,
      extra: { finding: (f) => ({ ...f, kind: "widget" }) },
    });
    expect(after.findings?.map((f) => f.kind)).toEqual(["widget"]);
  });

  it("skips the commit when the body was removed, linting the rendered draft", async () => {
    const { r, plan } = await setup(FILLED);
    const { after, notes } = await step(r, plan, { change: (abs) => rm(abs) });
    expect(after).toEqual({ findings: [], commit: false });
    expect(notes).toEqual([
      `${BODY} was removed while editing; the rendered draft is still staged. Restore it with \`git checkout -- ${BODY}\``,
    ]);
  });

  it("commits after a failed editor that left the body as rendered; editorNotes reports its note", async () => {
    const { r, plan } = await setup(FILLED);
    const plain = await step(r, plan, { exit: "vi exited with 1" });
    expect(plain.after).toEqual({ findings: [], commit: true });
    expect(plain.notes).toEqual([]);
    const noted = await step(r, plan, { exit: "vi exited with 1", extra: { editorNotes: true } });
    expect(noted.after).toEqual({ findings: [], commit: true });
    expect(noted.notes).toEqual(["vi exited with 1"]);
  });

  it("skips the commit when the body changed while the editor failed, without re-staging it", async () => {
    const { r, plan } = await setup();
    const changed = `${BODY} changed while the editor failed; review it, then git add it and commit`;
    const plain = await step(r, plan, { change: fill, exit: "vi exited with 1" });
    expect(plain.after).toEqual({ findings: [], commit: false });
    expect(plain.notes).toEqual([changed]);
    expect(await stagedBody(r)).toBe(UNFILLED);
    const noted = await step(r, plan, {
      change: fill,
      exit: "vi exited with 1",
      extra: { editorNotes: true },
    });
    expect(noted.notes).toEqual(["vi exited with 1", changed]);
    // Without a commit there is nothing to skip: only the editor's note, with editorNotes.
    const staging = await step(r, plan, {
      change: fill,
      exit: "vi exited with 1",
      commitRequested: false,
      extra: { editorNotes: true },
    });
    expect(staging.after.commit).toBe(false);
    expect(staging.notes).toEqual(["vi exited with 1"]);
  });

  it("skips the commit when another path of the scope it's given changed while the editor was open", async () => {
    const { r, plan } = await setup();
    const touch = async (abs: string) => {
      await fill(abs);
      await writeFile(join(r.root, TEMPLATE), `${TEMPLATE_TEXT}\n`);
      await writeFile(join(r.root, OTHER), "y\n");
    };
    const late = await step(r, plan, { change: touch });
    expect(late.after).toEqual({ findings: [], commit: false });
    expect(late.notes).toEqual([
      `${TEMPLATE} changed while the editor was open; review it, then git add it and commit`,
    ]);
    // The scope applyPlan passes decides, not the plan's commitScope.
    const wider = await step(r, plan, { scope: [BODY, OTHER] });
    expect(wider.notes[0]).toBe(
      `${OTHER} changed while the editor was open; review it, then git add it and commit`,
    );
    const narrower = await step(r, plan, { change: fill, scope: [BODY] });
    expect(narrower.after).toEqual({ findings: [], commit: true });
    // Without a commit, nothing is checked.
    const staging = await step(r, plan, { change: fill, commitRequested: false });
    expect(staging.notes).toEqual([]);
  });
});
