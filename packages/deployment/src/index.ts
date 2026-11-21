/**
 * `@nikovirtala/deployment`: a project's deployment run (a state machine over injected steps), its
 * freeze flag, ledger, settings, deployment tasks, smoke verdict and provenance. The CDK target is
 * `@nikovirtala/deployment/cdk`; the in-memory stand-ins are `@nikovirtala/deployment/testing`.
 * See docs/04-deployment-v1.md in ark.
 */
export {
  Aws,
  defaultExec,
  type Env,
  type Exec,
  type ExecOptions,
  type ExecResult,
  tail,
  withoutCredentials,
} from "./aws.js";
export {
  type Freeze,
  type FreezeInput,
  type FreezeState,
  FreezeStore,
  frozenMessage,
  type SsmPort,
} from "./freeze.js";
export {
  DEFAULT_TASK_KEY_PREFIX,
  type DocumentsPort,
  Ledger,
  type LedgerOptions,
  type LedgerStore,
  type RunInput,
} from "./ledger.js";
export {
  type Effect,
  eventsFrom,
  IllegalTransitionError,
  type RunEvent,
  RunMachine,
  TERMINAL_PHASES,
  TRANSITIONS,
  type Transition,
  transition,
} from "./machine.js";
export {
  DEFAULT_HINTS,
  type Orchestration,
  orchestrate,
  type RunContext,
  type RunHints,
  type RunProvenance,
  type RunResult,
  type StepResult,
  type Steps,
  type SynthResult,
} from "./orchestrate.js";
export {
  clip,
  FREEZE_SCHEMA,
  type FreezeRecord,
  type FreezeSetBy,
  type LastGood,
  parseFreezeRecord,
  parseRunRecord,
  parseTaskRecord,
  phaseOf,
  RUN_SCHEMA,
  type RunOutcome,
  type RunPhase,
  type RunRecord,
  TASK_SCHEMA,
  type TaskOutcome,
  type TaskRecord,
  type TerminalPhase,
} from "./records.js";
export {
  contextArgs,
  type PublishResult,
  parseEnvFile,
  publishSettings,
  type ResolvedSettings,
  readSettings,
  resolveSettings,
  type SettingSpec,
  settingParameterName,
  type Values,
} from "./settings.js";
export {
  type Add,
  type AwsRunner,
  changedWithin,
  describeStack,
  isHealthyStackStatus,
  isNotFound,
  isReadOnlyCommand,
  READ_ONLY_EXCEPTIONS,
  type ReadOnlyAwsOptions,
  readOnlyAws,
  render,
  type StackInfo,
  taskOrder,
} from "./smoke/helpers.js";
export {
  type CheckContext,
  dryRunChecks,
  type PlannedCall,
  type PlannedCheck,
  type RunChecksOptions,
  renderPlan,
  runChecks,
  type SmokeCheck,
  type SmokeMainOptions,
  smokeMain,
} from "./smoke/runner.js";
export { runSmokeStage, type SmokeCommand, type SmokeStageDeps } from "./smoke/stage.js";
export {
  judge,
  parseResults,
  type Result,
  type SmokeVerdict,
  STATUSES,
  type Status,
  templateOutputKeys,
} from "./smoke/verdict.js";
export type { Target } from "./target.js";
export {
  classifyTaskFile,
  type DiscoverOptions,
  deletable,
  discoverTasks,
  MODULE_EXTENSIONS,
  type TaskFile,
  type TaskKind,
} from "./tasks/discover.js";
export { listTasks, type TaskListing, type TaskValidation, validateTask } from "./tasks/listing.js";
export {
  lastJsonLine,
  needsSchema,
  ProcessExecutor,
  type ProcessExecutorOptions,
  parseNeeds,
  shimPath,
  TASK_ENV,
  type TaskContext,
  type TaskEnvNames,
  type TaskExecutor,
  type TaskMode,
  type TaskModule,
  type TaskNeeds,
  type TaskResult,
} from "./tasks/protocol.js";
export {
  type RolePolicy,
  type RunTasksDeps,
  runTasks,
  type TaskReport,
  validateNeeds,
} from "./tasks/runner.js";
