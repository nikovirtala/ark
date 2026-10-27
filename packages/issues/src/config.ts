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
import { issueKind, LABEL } from "./kind.js";

/** The default `[commit] subject`. */
export const DEFAULT_COMMIT_SUBJECT = "docs(issues): {action} {title}";

/** issues' settings from `issues.toml` (design "Config"); every key is optional. */
export interface IssuesConfig {
  /** `[log] default_template`: the template `issues new` uses without `--template`. */
  readonly defaultTemplate: string;
  /** `[log] main_branch`: the ref numbers come from; `null` resolves it automatically. */
  readonly mainBranch: string | null;
  /** `[log] index`: `"committed"` keeps `<root>/index.md` generated and fresh (ADR-0010). */
  readonly index: "none" | "committed";
  /** `[labels] exclusive`: prefixes an issue can hold one label of. */
  readonly exclusive: readonly string[];
  /** `[labels] priority`: labels in priority order, highest first, for `issues ready`. */
  readonly priority: readonly string[];
  /** `[policy] close_requires_human`. */
  readonly closeRequiresHuman: boolean;
  /** `[policy] mcp_can_close`: whether agents may close issues at all. */
  readonly mcpCanClose: boolean;
  /** `[policy] auto_commit`: commit writes without `--commit`. */
  readonly autoCommit: boolean;
  /** `[verify] fail_on`. */
  readonly failOn: Severity;
  /** `[commit] subject`: the template of `--commit` subjects. */
  readonly commitSubject: CommitTemplate;
  /** `[scope] anchor_keyword`: the code-anchor keyword, `issue` in `// issue:<id>`. */
  readonly anchorKeyword: string;
  /** `[scope] anchor_exclude`: globs of files whose anchors are ignored. */
  readonly anchorExclude: readonly string[];
}

export const DEFAULT_ISSUES_CONFIG: IssuesConfig = Object.freeze({
  defaultTemplate: "task",
  mainBranch: null,
  index: "none",
  exclusive: Object.freeze([]) as readonly string[],
  priority: Object.freeze([]) as readonly string[],
  closeRequiresHuman: false,
  mcpCanClose: true,
  autoCommit: false,
  failOn: "error",
  commitSubject: parseCommitTemplate(DEFAULT_COMMIT_SUBJECT, {
    vars: COMMIT_VARS,
    where: "commit.subject",
    names: COMMIT_NAMES,
  }),
  anchorKeyword: issueKind.anchorKeyword,
  anchorExclude: Object.freeze([]) as readonly string[],
});

const TEMPLATE = /^[a-z][a-z0-9-]*$/;
const KEYWORD = /^[a-z][a-z0-9-]{0,31}$/;
const PREFIX = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const LABEL_RE = new RegExp(LABEL);
const MAX_LABEL_KEYS = 50;
const MAX_ANCHOR_EXCLUDE = 100;
const SOURCE_KINDS = ["issues", "adr"] as const;

function isTable(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/**
 * Validates `issues.toml` (ledger's parsed `ToolConfig`; `null` when there is none), as adr's
 * `parseAdrConfig` does. A wrong type or value throws `ConfigError` naming the file and key;
 * unknown keys (`[hooks]` included) are ignored, so newer files still load. `[log] root` is
 * ledger's (`openToolLog` already checked it).
 */
export function parseIssuesConfig(config: ToolConfig | null, file: string | null): IssuesConfig {
  if (config === null) return DEFAULT_ISSUES_CONFIG;
  const where = file ?? config.file ?? "issues.toml";
  const fail = (message: string) => new ConfigError(`${where}: ${message}`, { file: where });
  const table = (name: string): Record<string, unknown> => {
    const t = config.raw[name];
    if (t === undefined) return {};
    if (!isTable(t)) throw fail(`${name} must be a table`);
    return t;
  };
  const log = table("log");
  const labels = table("labels");
  const policy = table("policy");
  const verify = table("verify");
  const scope = table("scope");
  const bool = (t: Record<string, unknown>, section: string, key: string, fallback: boolean) => {
    const v = t[key];
    if (v === undefined) return fallback;
    if (typeof v !== "boolean") throw fail(`${section}.${key} must be true or false`);
    return v;
  };
  const strings = (
    t: Record<string, unknown>,
    key: string,
    what: "prefix" | "label",
    pattern: RegExp,
  ): readonly string[] => {
    const whats = what === "prefix" ? "prefixes" : "labels";
    const v = t[key];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > MAX_LABEL_KEYS) {
      throw fail(`labels.${key} must be an array of at most ${MAX_LABEL_KEYS} ${whats}`);
    }
    v.forEach((x: unknown, i) => {
      if (typeof x !== "string" || !pattern.test(x)) {
        throw fail(`labels.${key}[${i}] must be a ${what} matching ${pattern.source}`);
      }
      if (v.indexOf(x) !== i)
        throw fail(`labels.${key}[${i}] ${JSON.stringify(x)} is listed twice`);
    });
    return v as string[];
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
  const index = log.index;
  if (index !== undefined && index !== "none" && index !== "committed") {
    throw fail('log.index must be "none" or "committed"');
  }
  const failOn = verify.fail_on;
  if (failOn !== undefined && failOn !== "error" && failOn !== "warning") {
    throw fail('verify.fail_on must be "error" or "warning"');
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
  config.sources.forEach((s, i) => {
    if (!(SOURCE_KINDS as readonly string[]).includes(s.kind)) {
      throw fail(`sources[${i}].kind must be "issues" or "adr"`);
    }
    if (s.name === "adr") {
      throw fail(`sources[${i}]: source name adr is reserved for this repository's decision log`);
    }
  });
  return {
    defaultTemplate:
      typeof template === "string" ? template : DEFAULT_ISSUES_CONFIG.defaultTemplate,
    mainBranch: typeof main === "string" ? main : null,
    index: index === "committed" ? "committed" : "none",
    exclusive: strings(labels, "exclusive", "prefix", PREFIX),
    priority: strings(labels, "priority", "label", LABEL_RE),
    closeRequiresHuman: bool(policy, "policy", "close_requires_human", false),
    mcpCanClose: bool(policy, "policy", "mcp_can_close", true),
    autoCommit: bool(policy, "policy", "auto_commit", false),
    failOn: failOn === "warning" ? "warning" : "error",
    commitSubject: readCommitTemplate(config, {
      file: where,
      vars: COMMIT_VARS,
      defaultSubject: DEFAULT_COMMIT_SUBJECT,
      names: COMMIT_NAMES,
    }),
    anchorKeyword: typeof keyword === "string" ? keyword : DEFAULT_ISSUES_CONFIG.anchorKeyword,
    anchorExclude: Array.isArray(exclude) ? (exclude as string[]) : [],
  };
}
