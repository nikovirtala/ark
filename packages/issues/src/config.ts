import {
  type CommitTemplate,
  parseCommitTemplate,
  parseSharedKeys,
  type Severity,
  type ToolConfig,
  toolConfigReader,
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
  /** `[hooks] scope_follow_renames`: what the pre-commit hook does with renames of covered files. */
  readonly scopeFollowRenames: "stage" | "warn" | "off";
  /** `[hooks] index`: `"stage"` lets the pre-commit hook regenerate and stage `index.md`. */
  readonly hookIndex: "check" | "stage";
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
  scopeFollowRenames: "stage",
  hookIndex: "check",
});

const PREFIX = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const LABEL_RE = new RegExp(LABEL);
const MAX_LABEL_KEYS = 50;
const SOURCE_KINDS = ["issues", "adr"] as const;

/**
 * Validates `issues.toml` (ledger's parsed `ToolConfig`; `null` when there is none), as adr's
 * `parseAdrConfig` does. A wrong type or value throws `ConfigError` naming the file and key;
 * unknown keys are ignored, so newer files still load. `[log] root` is
 * ledger's (`openToolLog` already checked it).
 */
export function parseIssuesConfig(config: ToolConfig | null, file: string | null): IssuesConfig {
  if (config === null) return DEFAULT_ISSUES_CONFIG;
  const reader = toolConfigReader(config, file, "issues");
  const shared = parseSharedKeys(reader, {
    defaults: {
      defaultTemplate: DEFAULT_ISSUES_CONFIG.defaultTemplate,
      anchorKeyword: DEFAULT_ISSUES_CONFIG.anchorKeyword,
      commit: { vars: COMMIT_VARS, names: COMMIT_NAMES, defaultSubject: DEFAULT_COMMIT_SUBJECT },
    },
    indexValues: ["none", "committed"],
  });
  const { fail, table, bool } = reader;
  const labels = table("labels");
  const policy = table("policy");
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

  config.sources.forEach((s, i) => {
    if (!(SOURCE_KINDS as readonly string[]).includes(s.kind)) {
      throw fail(`sources[${i}].kind must be "issues" or "adr"`);
    }
    if (s.name === "adr") {
      throw fail(`sources[${i}]: source name adr is reserved for this repository's decision log`);
    }
  });
  return {
    defaultTemplate: shared.defaultTemplate,
    mainBranch: shared.mainBranch,
    index: shared.index,
    exclusive: strings(labels, "exclusive", "prefix", PREFIX),
    priority: strings(labels, "priority", "label", LABEL_RE),
    closeRequiresHuman: bool(policy, "policy", "close_requires_human", false),
    mcpCanClose: bool(policy, "policy", "mcp_can_close", true),
    autoCommit: shared.autoCommit,
    failOn: shared.failOn,
    commitSubject: shared.commitSubject,
    anchorKeyword: shared.anchorKeyword,
    anchorExclude: shared.anchorExclude,
    scopeFollowRenames: shared.scopeFollowRenames,
    hookIndex: shared.hookIndex,
  };
}
