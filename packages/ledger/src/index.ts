/**
 * Version tag of the shared event envelope that every ledger-based kind writes.
 */
export const ENVELOPE_VERSION = "ledger/v1" as const;

export type EnvelopeVersion = typeof ENVELOPE_VERSION;

export {
  ConfigError,
  EventExistsError,
  GitError,
  GitNotFoundError,
  GitVersionError,
  HookShimError,
  InvalidArgumentError,
  type JsonValue,
  KindDefinitionError,
  LedgerError,
  type LedgerErrorCode,
  NotARepositoryError,
  RefNotFoundError,
  SourceFetchError,
  VerifyUsageError,
} from "./errors.js";
export {
  exitCode,
  type Finding,
  type FindingsSummary,
  finding,
  type Severity,
  sortFindings,
  summarize,
} from "./findings/finding.js";
export { type FindingsReport, formatGithub, formatJson, formatText } from "./findings/format.js";
export {
  GIT_ENV_ISOLATION,
  GIT_LOCATING_ENV,
  Git,
  type GitOptions,
  type RunOptions,
  type RunResult,
  type Trailer,
} from "./git/git.js";
export {
  type CommitInfo,
  firstParentAdditions,
  firstParentHistory,
  parseTrailerBlock,
} from "./git/history.js";
export {
  indexReader,
  MemoryTree,
  refReader,
  type TreeEntry,
  type TreeReader,
  worktreeReader,
} from "./git/tree.js";
