/**
 * Test-only values and arbitraries for issue logs. Never bundled or packed: excluded from
 * `tsconfig.json`, included in `tsconfig.test.json`.
 */
import type { Actor } from "@nikovirtala/ledger";
import fc from "fast-check";
import { DEFAULT_ISSUE_OPTIONS, type IssueOptions } from "../kind.js";

/** An agent actor (adr's test value; issues may import only `@nikovirtala/adr/kind`). */
export const TEST_AGENT: Actor = Object.freeze({
  kind: "agent",
  name: "test-agent",
  email: null,
  agent: "test-agent",
  on_behalf_of: "test@example.com",
});

/** A title: 1–80 printable ASCII characters (so one line), trimmed, not starting with `#`. */
export const arbTitle: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 80, unit: "grapheme-ascii" })
  .map((s) => s.trim())
  .filter((s) => s !== "" && !s.startsWith("#"));

/** A reason: 1–40 characters with a non-blank one. */
export const arbReason: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim() !== "");

/** Labels the generators draw from; `priority` and `type` are exclusive in the test options. */
export const LABEL_POOL: readonly string[] = Object.freeze([
  "priority:high",
  "priority:low",
  "type:bug",
  "type:feature",
  "area:cli",
  "good-first",
]);

export const ASSIGNEE_POOL: readonly string[] = Object.freeze([
  "ann@example.com",
  "bob@example.com",
  "cy@example.com",
  "dee",
]);

export const GLOB_POOL: readonly string[] = Object.freeze([
  "src/**",
  "docs/**",
  "infra/*.tf",
  "package.json",
]);

/** The options every generated history verifies clean under. */
export const ISSUE_TEST_OPTIONS: IssueOptions = Object.freeze({
  ...DEFAULT_ISSUE_OPTIONS,
  exclusive: Object.freeze(["priority", "type"]),
});
