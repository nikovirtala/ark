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
