// Shared setup of the semantic-tamper test files. Not exported from the testing entry.
import fc from "fast-check";
import { compileKind } from "../envelope/kind.js";
import type { Finding } from "../findings/finding.js";
import { MemoryTree } from "../git/tree.js";
import type { AnyKind } from "../kind/types.js";
import { verifySnapshots } from "../verify/verify.js";
import { exampleMachineKind as widget } from "./example-machine-kind.js";
import { arbLegalHistory, type DataArbs, type LegalHistory } from "./history.js";

export const widgetData: DataArbs<typeof widget> = {
  created: () => fc.record({ title: fc.string({ minLength: 1, maxLength: 20 }) }),
  noted: () => fc.record({ text: fc.string({ minLength: 1, maxLength: 20 }) }),
  published: () => fc.constant({}),
  retired: () => fc.constant({}),
  revived: () => fc.constant({}),
};
export const body = () => fc.string({ maxLength: 80 });
export const histories = () => arbLegalHistory(widget, { data: widgetData, body });
export const scopes = ["all", "changed"] as const;

/** Scope `all` checks the tampered tree alone; scope `changed` checks it against the history. */
export function verify<K extends AnyKind>(
  kind: K,
  h: LegalHistory<K>,
  head: Record<string, string>,
  scope: "all" | "changed",
): Promise<Finding[]> {
  return verifySnapshots({
    kind: compileKind(kind),
    layout: h.layout,
    base: scope === "all" ? null : new MemoryTree(h.files),
    head: new MemoryTree(head),
    scope,
  });
}
