import { type JsonValue, MAX_GLOB_LENGTH } from "@nikovirtala/ledger";
import { ASSIGNEE, LABEL } from "../kind/schemas.js";
import { ISSUE_STATES } from "../kind.js";
import { type IssueLog, openIssueLog, readIssues, readSourceIssues } from "../log.js";

/** Where `issues mcp` runs: every call opens the log afresh from here (design D2). */
export interface IssuesMcpEnv {
  readonly cwd: string;
  readonly root: string | null;
  readonly env: NodeJS.ProcessEnv;
}

export type Schema = Readonly<Record<string, JsonValue>>;

/** An issue of this log: its id, `17`, `0017` or `?17`. */
export const ID: Schema = { type: "string", minLength: 1, maxLength: 64 };
/** A relation target: as `ID`, `<source>:<id>`, or a decision for `implements`. */
export const REF: Schema = { type: "string", minLength: 1, maxLength: 100 };
/** Comment and reason text. */
export const TEXT: Schema = { type: "string", minLength: 1, maxLength: 65_536 };
/** Section id → markdown. */
export const SECTIONS: Schema = {
  type: "object",
  propertyNames: { type: "string", pattern: "^[a-z][a-z0-9-]*$", maxLength: 64 },
  additionalProperties: { type: "string", maxLength: 65_536 },
  maxProperties: 50,
};
/** Labels, at most `max`. */
export const LABELS = (max = 50): Schema => ({
  type: "array",
  items: { type: "string", pattern: LABEL },
  maxItems: max,
});
export const GLOBS: Schema = {
  type: "array",
  items: { type: "string", minLength: 1, maxLength: MAX_GLOB_LENGTH },
  maxItems: 200,
};
/** Assignees; `me` is the address the server acts for. */
export const ASSIGNEES: Schema = {
  type: "array",
  items: { type: "string", pattern: ASSIGNEE },
  maxItems: 20,
};
/** A `[[sources]]` name, read from the local cache. */
export const SOURCE: Schema = { type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$" };
export const STATES: Schema = {
  type: "array",
  items: { type: "string", enum: [...ISSUE_STATES] },
  uniqueItems: true,
  minItems: 1,
  maxItems: ISSUE_STATES.length,
};
/** `--limit`. */
export const LIMIT: Schema = { type: "integer", minimum: 1, maximum: 1000 };

export const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: "object",
  properties,
  ...(required.length === 0 ? {} : { required }),
  additionalProperties: false,
});

export const READ = { readOnlyHint: true, openWorldHint: false } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

/** The log for one call, opened again so outside edits and `issues.toml` changes are seen. */
export const openLog = (e: IssuesMcpEnv, ref: string | null = null): Promise<IssueLog> =>
  openIssueLog({ cwd: e.cwd, root: e.root, ref, gitOptions: { env: e.env } });

/** The local log, or with `source` that `[[sources]]` entry's cached log (never the network). */
export async function readFor(e: IssuesMcpEnv, source: string | null) {
  const log = await openLog(e);
  return {
    log,
    read: source === null ? await readIssues(log) : await readSourceIssues(log, source),
  };
}

export const str = (v: JsonValue | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;
export const strings = (v: JsonValue | undefined): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
export const int = (v: JsonValue | undefined): number | undefined =>
  typeof v === "number" ? v : undefined;

export const doc = (d: unknown): JsonValue => d as JsonValue;
