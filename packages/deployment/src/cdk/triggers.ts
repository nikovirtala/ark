/**
 * CloudFormation rollback triggers for a CDK deploy, moved from longplay's `infra/pipeline/deploy.ts`.
 *
 * `cdk deploy --rollback-trigger-alarm-arns <arn> ... --monitoring-time-minutes <n>`
 * (https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-deploy.html) passes a RollbackConfiguration
 * to CloudFormation: if any listed alarm goes to ALARM during the update or the monitoring period
 * after it, CloudFormation rolls the update back
 * (https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-rollback-triggers.html).
 * Three rules from that page decide which alarms are passed: at most 5; a missing alarm fails the
 * whole deploy; and an alarm that is not OK when the deploy starts is left out, because it would roll
 * back the deploy that is meant to fix it.
 */
import type { Aws, Env } from "../aws.js";

export const MAX_ROLLBACK_TRIGGERS = 5;

/**
 * An alarm that is OK when the deploy starts but went to ALARM this recently is left out too. A job
 * that fails on every run can make an alarm flap: longplay's `plays-queue-age` went in and out of
 * ALARM every 15 minutes while its committer failed, was OK at the start of the deploy that fixed the
 * committer, and rolled it back 40 seconds later. An hour covers a platform's schedules.
 */
export const RECENT_ALARM_MINUTES = 60;

/** How long CloudFormation keeps watching the alarms after the resources are deployed. 0 to 180. */
export const DEFAULT_MONITORING_MINUTES = 10;

export interface AlarmSummary {
  readonly AlarmName: string;
  readonly AlarmArn: string;
  readonly StateValue: string;
  /** When it last went to ALARM within the last `RECENT_ALARM_MINUTES`, if it did (from its state history). */
  readonly LastAlarmAt?: string;
  /** Why its state history could not be read, if it could not. It stays a trigger then. */
  readonly HistoryError?: string;
}

export interface TriggerSelection {
  /** In the order of the wanted names. */
  readonly arns: readonly string[];
  /** Names that were left out, and why, for the log. */
  readonly left: readonly string[];
}

export function selectRollbackTriggers(
  wanted: readonly string[],
  existing: readonly AlarmSummary[],
): TriggerSelection {
  const arns: string[] = [];
  const left: string[] = [];
  for (const name of wanted) {
    const alarm = existing.find((a) => a.AlarmName === name);
    if (!alarm) left.push(`${name}: does not exist yet (a missing alarm would fail the deploy)`);
    else if (alarm.StateValue !== "OK") {
      left.push(
        `${name}: is ${alarm.StateValue} before the deploy (it would roll back the deploy that fixes it)`,
      );
    } else if (alarm.LastAlarmAt) {
      left.push(
        `${name}: was ALARM at ${alarm.LastAlarmAt}, within the last ${RECENT_ALARM_MINUTES} minutes (an alarm that flaps would roll back the deploy that fixes it)`,
      );
    } else if (arns.length >= MAX_ROLLBACK_TRIGGERS) {
      left.push(`${name}: CloudFormation takes at most ${MAX_ROLLBACK_TRIGGERS} rollback triggers`);
    } else arns.push(alarm.AlarmArn);
  }
  return { arns, left };
}

/**
 * The project's alarms, and for each of `wanted` that is OK, when it last went to ALARM within
 * `RECENT_ALARM_MINUTES`. With a prefix it lists the alarms by prefix, as longplay does; without
 * one, by the wanted names.
 */
export function listExistingAlarms(
  aws: Aws,
  env: Env,
  wanted: readonly string[],
  options: { prefix?: string; now?: Date } = {},
): AlarmSummary[] {
  if (wanted.length === 0) return [];
  const now = options.now ?? new Date();
  const select = options.prefix
    ? ["--alarm-name-prefix", options.prefix]
    : ["--alarm-names", ...wanted];
  const out = aws.json(
    [
      "cloudwatch",
      "describe-alarms",
      ...select,
      "--alarm-types",
      "MetricAlarm",
      "--query",
      "MetricAlarms[].{AlarmName:AlarmName,AlarmArn:AlarmArn,StateValue:StateValue}",
    ],
    env,
  ) as AlarmSummary[] | undefined;
  const since = new Date(now.getTime() - RECENT_ALARM_MINUTES * 60_000).toISOString();
  return (out ?? []).map((alarm) => {
    if (alarm.StateValue !== "OK" || !wanted.includes(alarm.AlarmName)) return alarm;
    try {
      const last = aws.json(
        [
          "cloudwatch",
          "describe-alarm-history",
          "--alarm-name",
          alarm.AlarmName,
          "--history-item-type",
          "StateUpdate",
          "--start-date",
          since,
          "--query",
          "AlarmHistoryItems[?ends_with(HistorySummary, 'to ALARM')] | [0].Timestamp",
        ],
        env,
      );
      return typeof last === "string" ? { ...alarm, LastAlarmAt: last } : alarm;
    } catch (e) {
      // A deploy role without cloudwatch:DescribeAlarmHistory must not stop the deploy.
      return { ...alarm, HistoryError: e instanceof Error ? e.message : String(e) };
    }
  });
}
