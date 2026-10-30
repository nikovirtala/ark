export {
  type BodyPolicy,
  type CompiledKind,
  compileKind,
  type EventTypeSchema,
  type KindSchema,
  type ValidationResult,
} from "./envelope/kind.js";
export { envelopeSchema } from "./envelope/schema.js";
export {
  type Actor,
  ENVELOPE_KEYS,
  type EventEnvelope,
  type JsonSchema,
  unknownFields,
} from "./envelope/types.js";
export { ENVELOPE_VERSION, type EnvelopeVersion } from "./envelope/version.js";
export {
  canonicalEvent,
  MAX_EVENT_BYTES,
  type ParseResult,
  parseEventYaml,
  serializeEvent,
} from "./envelope/yaml.js";
export {
  CommitFailedError,
  type CommitRecovery,
  ConfigError,
  EventExistsError,
  FileChangedError,
  FileExistsError,
  GitError,
  GitNotFoundError,
  GitVersionError,
  HookConflictError,
  type HookConflictResult,
  HookShimError,
  InvalidArgumentError,
  type JsonValue,
  KindDefinitionError,
  LedgerError,
  type LedgerErrorCode,
  NotARepositoryError,
  RefNotFoundError,
  SourceFetchError,
  UsageError,
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
export {
  type FindingsReport,
  findingsReport,
  formatGithub,
  formatJson,
  formatText,
} from "./findings/format.js";
export { compareEvents, foldLog, foldSubject, sortInLogOrder } from "./fold/fold.js";
export {
  assignNumbers,
  compareNumberingKeys,
  NO_NUMBERING,
  type Numbering,
  numberLog,
  PENDING_COMMIT,
  projectNumbering,
  resolveMainRef,
} from "./fold/numbering.js";
export { kindFindings, type Projection, projectLog } from "./fold/project.js";
export {
  commitMessageText,
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
export { invalidateGitOperation, withGitOperation } from "./git/operation.js";
export {
  indexReader,
  MemoryTree,
  overlayTree,
  refReader,
  type TreeEntry,
  type TreeReader,
  worktreeReader,
} from "./git/tree.js";
export {
  assertNoHookConflicts,
  type HookInstallResult,
  installHooks,
  readHookRegistry,
  uninstallHooks,
} from "./hooks/install.js";
export {
  DEFAULT_HOOK_COMMANDS,
  type HookName,
  type HookRegistration,
  parseShim,
  renderShim,
} from "./hooks/shim.js";
export { type HookManager, hookSnippet } from "./hooks/snippets.js";
export { CROCKFORD, decodeCrockford, encodeCrockford } from "./identity/crockford.js";
export {
  bodyFileName,
  type EventFileName,
  eventFileName,
  formatEventFileName,
  isEventType,
  parseBodyFileName,
  parseEventFileName,
  slugify,
} from "./identity/files.js";
export { bodySha256, findDuplicates } from "./identity/hash.js";
export { isSubjectId, newSubjectId } from "./identity/ids.js";
export {
  classifyPath,
  eventDir,
  eventPath,
  type LogLayout,
  normalizeLayout,
  type PathClass,
} from "./identity/layout.js";
export { atToStamp, formatAt, isAt } from "./identity/time.js";
export {
  createUlidFactory,
  isUlid,
  type UlidFactoryOptions,
  ulid,
  ulidTime,
} from "./identity/ulid.js";
export { defineKind, eventType, isKind } from "./kind/define.js";
export type {
  AnyKind,
  AppliedEvent,
  DataOf,
  DataOfType,
  EventDefs,
  EventDefsOf,
  EventTypeDef,
  EventTypesOf,
  FoldEvent,
  FoldedLog,
  FoldedLogOf,
  FoldedSubject,
  FoldedSubjectOf,
  Kind,
  KindDef,
  KindFinding,
  OptionsOf,
  ProjectContext,
  StateMachine,
  StateOf,
  StatesOf,
  ViewOf,
} from "./kind/types.js";
export {
  type LoadedEvent,
  type LoadedSubject,
  type LogSnapshot,
  loadLog,
} from "./log/snapshot.js";
export {
  nextEventIdentity,
  replaceFile,
  writeEvent,
  writeEvents,
  writeNewFile,
} from "./log/write.js";
export {
  escapeMarkdown,
  firstLine,
  headBytes,
  headTree,
  holdsText,
  INDEX_FORMAT,
  type IndexSpec,
  indexCheck,
  parseIndexNumbers,
  readIndexNumbers,
  renderIndex,
  withoutPaths,
  writeIndexCopy,
  writeIndexFile,
} from "./log-index/index.js";
export { type Anchor, anchorsInLine, scanAnchors } from "./scope/anchors.js";
export {
  anchorCheck,
  type GovernedChange,
  governedChanges,
  type NarrowedScope,
  narrowedScopes,
  scopeGlobCheck,
} from "./scope/checks.js";
export {
  escapeGlob,
  type Glob,
  type GlobProblem,
  globMatcher,
  MAX_GLOB_LENGTH,
  parseGlob,
} from "./scope/glob.js";
export {
  type ScopeMatch,
  type ScopeVia,
  scopedSubjects,
  scopeLookup,
} from "./scope/lookup.js";
export {
  type FollowResult,
  followRenames,
  type Rename,
  stagedRenames,
} from "./scope/renames.js";
export {
  applySetOp,
  latestSet,
  type SetOp,
  type SetOpResult,
  setEventType,
} from "./scope/set.js";
export {
  MAX_CONFIG_BYTES,
  parseToolConfig,
  readToolConfig,
  type SourceConfig,
  type ToolConfig,
} from "./sources/config.js";
export { type FetchedSource, fetchSource } from "./sources/fetch.js";
export {
  formatQualifiedId,
  parseQualifiedId,
  type QualifiedId,
} from "./sources/qualified-id.js";
export {
  readSources,
  type SourceRead,
  type SourceStatus,
  sourceFindings,
  sourcesOfKinds,
} from "./sources/read.js";
export {
  type LogRef,
  type Resolution,
  resolveQualifiedId,
  sourceLogRef,
} from "./sources/resolve.js";
export {
  type Attribution,
  parseOnBehalfOf,
  resolveActor,
  resolveAttribution,
} from "./surfaces/actor.js";
export {
  type CommitName,
  type CommitSlot,
  type CommitTemplate,
  checkCommitMessage,
  type EventRef,
  eventTrailers,
  joinActions,
  MAX_DESCRIPTION,
  MIN_TITLE_ROOM,
  parseCommitTemplate,
  type RenderedCommit,
  readCommitTemplate,
  renderCommitMessage,
  wrapParagraph,
} from "./surfaces/commit-message.js";
export {
  type CommitInput,
  commitWithRecovery,
  saveCommitRecovery,
} from "./surfaces/commit-recovery.js";
export { renderStateHeader, type StateHeader } from "./surfaces/header.js";
export { resolveSubjectInput, type SubjectInput } from "./surfaces/subject-input.js";
export {
  countOccurrences,
  type FoldedText,
  foldText,
  searchExcerpt,
  searchTerms,
} from "./surfaces/text-search.js";
export { openToolLog, type ToolLog, type ToolLogOptions } from "./surfaces/tool-log.js";
export { findTemplateVersion, loadTemplates } from "./templates/history.js";
export { lintDocument, lintTemplate } from "./templates/lint.js";
export {
  MAX_TEMPLATE_BYTES,
  parseTemplate,
  type SectionSpec,
  type Template,
  type TemplateParse,
} from "./templates/parse.js";
export {
  extractSections,
  normalizeSection,
  renderTemplate,
  replaceSections,
} from "./templates/render.js";
export {
  gitTemplates,
  historyTemplates,
  type TemplateLookup,
  type TemplateSource,
  type TemplateSourceFactory,
  treeTemplates,
} from "./templates/source.js";
export {
  appendOnly,
  bodyPolicy,
  type Check,
  type CheckContext,
  duplicates,
  loadFindings,
  mechanicalChecks,
  type RepoContext,
} from "./verify/checks.js";
export { type Change, diffTrees } from "./verify/diff.js";
export { foldChecks, invariantsCheck, relateCheck, transitions } from "./verify/fold-checks.js";
export { templateCheck, templateHistoryRef } from "./verify/template-check.js";
export { touchedInputs, type VerifyMode, verifyLog, verifySnapshots } from "./verify/verify.js";
