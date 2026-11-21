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
