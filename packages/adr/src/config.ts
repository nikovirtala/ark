import {
  type CommitTemplate,
  ConfigError,
  parseCommitTemplate,
  parseGlob,
  readCommitTemplate,
  type Severity,
  type ToolConfig,
} from "@nikovirtala/ledger";
import { COMMIT_NAMES, COMMIT_VARS } from "./commit-actions.js";
import { adrKind } from "./kind.js";

/** The default `[commit] subject`. */
export const DEFAULT_COMMIT_SUBJECT = "docs(adr): {action} {title}";

/** adr's settings from `adr.toml` (design §5.3); every key is optional. */
export interface AdrConfig {
  /** `[log] default_template`: the template `adr new` uses without `--template`. */
  readonly defaultTemplate: string;
  /** `[log] main_branch`: the ref numbers come from; `null` resolves it automatically. */
  readonly mainBranch: string | null;
  /** `[log] index`: `committed` keeps a generated `<root>/index.md` fresh and verified. */
  readonly index: "committed" | "none";
  /** `[policy] accept_requires_human`. */
  readonly acceptRequiresHuman: boolean;
  /** `[policy] auto_commit`: commit writes without `--commit`. */
  readonly autoCommit: boolean;
  /** `[policy] mcp_can_decide`: validated now, used in phase 3. */
  readonly mcpCanDecide: boolean;
  /** `[verify] fail_on`. */
  readonly failOn: Severity;
  /** `[commit] subject`: the template of `--commit` subjects. */
  readonly commitSubject: CommitTemplate;
  /** `[scope] anchor_keyword`: the code-anchor keyword, `adr` in `// adr:<id>`. */
  readonly anchorKeyword: string;
  /** `[scope] anchor_exclude`: globs of files whose anchors are ignored (docs that show examples). */
  readonly anchorExclude: readonly string[];
}

export const DEFAULT_ADR_CONFIG: AdrConfig = Object.freeze({
  defaultTemplate: "nygard",
  mainBranch: null,
  index: "none",
  acceptRequiresHuman: true,
  autoCommit: false,
  mcpCanDecide: false,
  failOn: "error",
  commitSubject: parseCommitTemplate(DEFAULT_COMMIT_SUBJECT, {
    vars: COMMIT_VARS,
    where: "commit.subject",
    names: COMMIT_NAMES,
  }),
  anchorKeyword: adrKind.anchorKeyword,
  anchorExclude: Object.freeze([]),
});

const TEMPLATE = /^[a-z][a-z0-9-]*$/;
const KEYWORD = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_ANCHOR_EXCLUDE = 100;

function isTable(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/**
 * Validates `adr.toml` (ledger's parsed `ToolConfig`; `null` when there is none). A wrong type or
 * value throws `ConfigError` naming the file and key. Unknown keys are ignored, so newer files
 * still load. `[log] root` is ledger's (`openToolLog` already checked it).
 */
export function parseAdrConfig(config: ToolConfig | null, file: string | null): AdrConfig {
  if (config === null) return DEFAULT_ADR_CONFIG;
  const where = file ?? config.file ?? "adr.toml";
  const fail = (message: string) => new ConfigError(`${where}: ${message}`, { file: where });
  const table = (name: string): Record<string, unknown> => {
    const t = config.raw[name];
    if (t === undefined) return {};
    if (!isTable(t)) throw fail(`${name} must be a table`);
    return t;
  };
  const log = table("log");
  const policy = table("policy");
  const verify = table("verify");
  const scope = table("scope");
  const bool = (t: Record<string, unknown>, section: string, key: string, fallback: boolean) => {
    const v = t[key];
    if (v === undefined) return fallback;
    if (typeof v !== "boolean") throw fail(`${section}.${key} must be true or false`);
    return v;
  };
  const oneOf = <T extends string>(
    t: Record<string, unknown>,
    section: string,
    key: string,
    values: readonly T[],
    fallback: T,
  ): T => {
    const v = t[key];
    if (v === undefined) return fallback;
    if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
      throw fail(`${section}.${key} must be ${values.map((x) => JSON.stringify(x)).join(" or ")}`);
    }
    return v as T;
  };

  const template = log.default_template;
  if (
    template !== undefined &&
    (typeof template !== "string" || template.length > 64 || !TEMPLATE.test(template))
  ) {
    throw fail(`log.default_template must be a template name matching ${TEMPLATE.source}`);
  }
  const main = log.main_branch;
  if (
    main !== undefined &&
    (typeof main !== "string" || main.trim() === "" || main.startsWith("-") || main.includes("\0"))
  ) {
    throw fail("log.main_branch must be a ref name that doesn't start with -");
  }
  const keyword = scope.anchor_keyword;
  if (keyword !== undefined && (typeof keyword !== "string" || !KEYWORD.test(keyword))) {
    throw fail(`scope.anchor_keyword must match ${KEYWORD.source}`);
  }
  const exclude = scope.anchor_exclude;
  if (exclude !== undefined) {
    if (!Array.isArray(exclude) || exclude.length > MAX_ANCHOR_EXCLUDE) {
      throw fail(`scope.anchor_exclude must be an array of at most ${MAX_ANCHOR_EXCLUDE} globs`);
    }
    exclude.forEach((g: unknown, i) => {
      if (typeof g !== "string") throw fail(`scope.anchor_exclude[${i}] must be a string`);
      const parsed = parseGlob(g);
      if (!parsed.ok) throw fail(`scope.anchor_exclude[${i}]: ${parsed.message}`);
    });
  }
  return {
    defaultTemplate: typeof template === "string" ? template : DEFAULT_ADR_CONFIG.defaultTemplate,
    mainBranch: typeof main === "string" ? main : null,
    index: oneOf(log, "log", "index", ["committed", "none"] as const, "none"),
    acceptRequiresHuman: bool(policy, "policy", "accept_requires_human", true),
    autoCommit: bool(policy, "policy", "auto_commit", false),
    mcpCanDecide: bool(policy, "policy", "mcp_can_decide", false),
    failOn: oneOf(verify, "verify", "fail_on", ["error", "warning"] as const, "error"),
    commitSubject: readCommitTemplate(config, {
      file: where,
      vars: COMMIT_VARS,
      defaultSubject: DEFAULT_COMMIT_SUBJECT,
      names: COMMIT_NAMES,
    }),
    anchorKeyword: typeof keyword === "string" ? keyword : DEFAULT_ADR_CONFIG.anchorKeyword,
    anchorExclude: Array.isArray(exclude) ? (exclude as string[]) : [],
  };
}
