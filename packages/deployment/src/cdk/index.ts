/**
 * `@nikovirtala/deployment/cdk`: the CDK target (synth, deploy with rollback triggers, rollback), the
 * rollback-trigger selection, and provenance for a CDK app. It imports nothing from aws-cdk-lib: the
 * target runs the CDK CLI, and `provenanceFromContext` takes any node with `tryGetContext`.
 */
export {
  type ContextSource,
  otelResourceAttributes,
  PROVENANCE_CONTEXT,
  provenanceAttributes,
  provenanceContextArgs,
  provenanceFromContext,
} from "./provenance.js";
export { type CdkAppOptions, CdkTarget, type CdkTargetOptions, cdkArgs } from "./target.js";
export {
  type AlarmSummary,
  DEFAULT_MONITORING_MINUTES,
  listExistingAlarms,
  MAX_ROLLBACK_TRIGGERS,
  RECENT_ALARM_MINUTES,
  selectRollbackTriggers,
  type TriggerSelection,
} from "./triggers.js";
