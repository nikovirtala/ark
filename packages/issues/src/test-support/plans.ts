/** Test-only helpers that run write plans on an in-memory issue log. */
import { MemoryTree, NO_NUMBERING, type Numbering, treeTemplates } from "@nikovirtala/ledger";
import { DEFAULT_ISSUES_CONFIG, type IssuesConfig } from "../config.js";
import type { SourceLog } from "../kind.js";
import { type IssuesRead, readIssuesFrom } from "../log.js";
import type { PlanContext, WritePlan } from "../plan.js";
import type { DecisionLogRead } from "../sources.js";
import { BUILTIN_TEMPLATES, TASK_V1 } from "../templates/builtin.js";
import { LAYOUT } from "./events.js";

export type Files = Record<string, string | Uint8Array>;

/** An in-memory issue log that applies plans: its files, options and the current read. */
export class MemoryLog {
  files: Files;
  readonly #o: {
    issues: IssuesConfig;
    numbering: Numbering;
    sources: ReadonlyMap<string, SourceLog> | null;
    decisions: DecisionLogRead | null;
  };
  #clock: number;
  #counter = 0;

  constructor(
    files: Files = {},
    o: {
      issues?: Partial<IssuesConfig>;
      numbering?: Numbering;
      sources?: ReadonlyMap<string, SourceLog> | null;
      decisions?: DecisionLogRead | null;
      clock?: number;
    } = {},
  ) {
    this.files = { "docs/issues/templates/task.md": TASK_V1, ...files };
    this.#o = {
      issues: { ...DEFAULT_ISSUES_CONFIG, ...o.issues },
      numbering: o.numbering ?? NO_NUMBERING,
      sources: o.sources ?? null,
      decisions: o.decisions ?? null,
    };
    this.#clock = o.clock ?? Date.parse("2026-10-21T00:00:00Z");
  }

  read(): Promise<IssuesRead> {
    return readIssuesFrom(new MemoryTree(this.files), {
      layout: LAYOUT,
      issues: this.#o.issues,
      numbering: this.#o.numbering,
      sources: this.#o.sources,
      decisions: this.#o.decisions,
    });
  }

  /**
   * A context whose clock advances one second per call and whose randomness is a counter, so no
   * two planned events share an id.
   */
  context(read: IssuesRead): PlanContext {
    this.#clock += 1000;
    const now = this.#clock;
    const n = ++this.#counter;
    return {
      now: () => now,
      random: (buf) => {
        buf.fill(0);
        let v = n;
        for (let i = buf.length - 1; i >= 0 && v > 0; i--) {
          buf[i] = v & 0xff;
          v = Math.floor(v / 256);
        }
      },
      templates: treeTemplates(read.tree, `${read.root}/templates`),
      builtins: BUILTIN_TEMPLATES,
    };
  }

  /** Writes a plan's files and replacements. */
  apply(plan: WritePlan): void {
    this.files = { ...this.files, ...plan.files };
    for (const [p, r] of Object.entries(plan.replace ?? {})) this.files[p] = r.bytes;
  }
}
