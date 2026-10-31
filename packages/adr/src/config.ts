import {
  type CommitTemplate,
  parseCommitTemplate,
  parseSharedKeys,
  type Severity,
  type ToolConfig,
  toolConfigReader,
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
  /** `[verify] governed_by_inactive`: the severity of `decision/governed-by-inactive`. */
  readonly governedByInactive: Severity;
  /** `[hooks] scope_follow_renames`: what the pre-commit hook does with renames of covered files. */
  readonly scopeFollowRenames: "stage" | "warn" | "off";
  /** `[hooks] index`: whether the pre-commit hook only checks `index.md` or regenerates it. */
  readonly hookIndex: "check" | "stage";
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
  governedByInactive: "warning",
  scopeFollowRenames: "stage",
  hookIndex: "check",
  commitSubject: parseCommitTemplate(DEFAULT_COMMIT_SUBJECT, {
    vars: COMMIT_VARS,
    where: "commit.subject",
    names: COMMIT_NAMES,
  }),
  anchorKeyword: adrKind.anchorKeyword,
  anchorExclude: Object.freeze([]),
});

/**
 * Validates `adr.toml` (ledger's parsed `ToolConfig`; `null` when there is none). A wrong type or
 * value throws `ConfigError` naming the file and key. Unknown keys are ignored, so newer files
 * still load. `[log] root` is ledger's (`openToolLog` already checked it).
 */
export function parseAdrConfig(config: ToolConfig | null, file: string | null): AdrConfig {
  if (config === null) return DEFAULT_ADR_CONFIG;
  const reader = toolConfigReader(config, file, "adr");
  const shared = parseSharedKeys(reader, {
    defaults: {
      defaultTemplate: DEFAULT_ADR_CONFIG.defaultTemplate,
      anchorKeyword: DEFAULT_ADR_CONFIG.anchorKeyword,
      commit: { vars: COMMIT_VARS, names: COMMIT_NAMES, defaultSubject: DEFAULT_COMMIT_SUBJECT },
    },
    indexValues: ["committed", "none"],
  });
  const { table, bool, oneOf } = reader;
  const policy = table("policy");
  const verify = table("verify");
  return {
    defaultTemplate: shared.defaultTemplate,
    mainBranch: shared.mainBranch,
    index: shared.index,
    acceptRequiresHuman: bool(policy, "policy", "accept_requires_human", true),
    autoCommit: shared.autoCommit,
    mcpCanDecide: bool(policy, "policy", "mcp_can_decide", false),
    failOn: shared.failOn,
    governedByInactive: oneOf(
      verify,
      "verify",
      "governed_by_inactive",
      ["warning", "error"] as const,
      "warning",
    ),
    scopeFollowRenames: shared.scopeFollowRenames,
    hookIndex: shared.hookIndex,
    commitSubject: shared.commitSubject,
    anchorKeyword: shared.anchorKeyword,
    anchorExclude: shared.anchorExclude,
  };
}
