export { type AdrConfig, DEFAULT_ADR_CONFIG, parseAdrConfig } from "./config.js";
export {
  addHookTrailers,
  decisionHookCommands,
  type HooksResultJson,
  installDecisionHooks,
  printDecisionHooks,
  runPreCommitHook,
  uninstallDecisionHooks,
} from "./hooks.js";
export { type InitResultJson, initDecisionLog } from "./init.js";
export {
  type AdrOptions,
  adrKind,
  DECISION_STATUSES,
  type DecisionEvents,
  type DecisionState,
  type DecisionStatus,
  type DecisionView,
  formatDecisionNumber,
  type LinkRel,
  parseDecisionNumber,
  REF,
} from "./kind.js";
export {
  type ChangedSince,
  changedSince,
  type DecisionLog,
  type DecisionsRead,
  openDecisionLog,
  readDecisions,
  readDecisionsFrom,
  resolveDecision,
  sourcesNote,
} from "./log.js";
export { type IndexResultJson, indexDecisionLog, renderDecisionIndex } from "./log-index.js";
export {
  type DecisionForJson,
  type DecisionsForJson,
  decisionsFor,
  type UnresolvedAnchorJson,
} from "./scope.js";
export {
  type DecisionSearchJson,
  type DecisionSearchResultJson,
  searchDecisions,
} from "./search.js";
export { SKILL_MD } from "./skill.js";
export { listTemplates, type TemplatesJson } from "./templates/list.js";
export { adrChecks, verifyDecisions } from "./verify.js";
export {
  type DecisionListJson,
  type DecisionShowJson,
  listDecisions,
  type NumberingJson,
  showDecision,
  stateHeader,
} from "./views.js";
export {
  acceptDecision,
  type CopyScope,
  deprecateDecision,
  followScopeRenames,
  type LinkInput,
  linkDecision,
  noteDecision,
  type ProposeInput,
  proposeDecision,
  type ReasonInput,
  rejectDecision,
  type ScopeInput,
  type ScopeOffer,
  scopeDecision,
  scopeToCopy,
  supersedeDecision,
  type UpdateDraftInput,
  updateDraft,
  type WriteOptions,
  type WriteResultJson,
  withdrawDecision,
} from "./write.js";
