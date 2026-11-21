/** longplay's names and settings, as its deploy.toml would give them when it moves onto the package. */
import * as fs from "node:fs";
import * as path from "node:path";
import type { SettingSpec } from "../settings.js";

/** longplay's PLATFORM_SETTINGS, unchanged. */
export const LONGPLAY_SETTINGS: readonly SettingSpec[] = [
  {
    key: "PLATFORM_ALARM_EMAIL",
    context: "platformAlarmEmail",
    required: "A platform deploy without it removes the alarm topic's email subscription.",
    fallback: "ALARM_EMAIL",
  },
  { key: "PLATFORM_BUDGET_USD", context: "platformBudgetUsd" },
  { key: "PLATFORM_TABLE_BUCKET_SUFFIX", context: "platformTableBucketSuffix" },
  {
    key: "PLATFORM_HOSTED_ZONE_ID",
    context: "platformHostedZoneId",
    required: "A platform deploy without it removes the API's certificate, domain and DNS record.",
    pattern: /^Z[A-Z0-9]{5,31}$/,
    patternHint: "a hosted zone id like Z0123456789ABCDEFGHIJ, without /hostedzone/",
  },
  { key: "PLATFORM_HOSTED_ZONE_NAME", context: "platformHostedZoneName" },
  { key: "PLATFORM_API_DOMAIN", context: "platformApiDomain" },
  { key: "PLATFORM_COGNITO_DOMAIN_PREFIX", context: "platformCognitoDomainPrefix" },
  { key: "PLATFORM_APPLE_SECRET_NAME", context: "platformAppleSecretName" },
  { key: "PLATFORM_LASTFM_SECRET_NAME", context: "platformLastfmSecretName" },
  {
    key: "PLATFORM_SITE_BUCKET_NAME",
    context: "platformSiteBucketName",
    required:
      "A platform deploy without it removes the nightly parity run, its schedule and its alarms.",
    pattern: /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
    patternHint: "a bucket name (lowercase letters, digits, dots and hyphens)",
  },
];

const here = import.meta.dirname;
/** The fixture is DynamoDB's JSON; every attribute of the ledger is a string. */
const unmarshall = (item: Record<string, { S: string }>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(item).map(([k, v]) => [k, v.S]));
/** Every item of longplay's ledger table, read on 2026-11-21, unmarshalled. */
export const LONGPLAY_ITEMS = (
  JSON.parse(fs.readFileSync(path.join(here, "longplay-ledger.json"), "utf8")) as {
    items: Record<string, { S: string }>[];
  }
).items.map((i) => unmarshall(i));
/** longplay's freeze flag value, read on 2026-11-21. */
export const LONGPLAY_FREEZE = (
  JSON.parse(fs.readFileSync(path.join(here, "longplay-freeze.json"), "utf8")) as { value: string }
).value;

/** longplay's smoke stage: its markers (TASK_MARKER_OUTPUTS), the checks, and the commands around them. */
export const LONGPLAY_MARKERS: Readonly<Record<string, string>> = {
  "1.5": "PolicyStoreId",
  "2.4": "SettingsUrl",
  "2.5": "PlaysQueueUrl",
  "2.6": "ParityReportsBucketName",
  "4.1": "DemandBusName",
};
export const LONGPLAY_SMOKE_COMMAND = ["node", "infra/scripts/verify-platform.ts"];
export const LONGPLAY_SMOKE_BEFORE = [
  {
    name: "record-test-run",
    task: "1.7",
    argv: ["node", "infra/scripts/record-test-run.ts"],
    role: "record",
    env: { RUNS_TABLE: "longplay-platform-runs" },
  },
];
export const LONGPLAY_SMOKE_AFTER = [
  {
    name: "simulate-approval-policy.ts --deployed",
    task: "1.4",
    argv: ["node", "infra/scripts/simulate-approval-policy.ts", "--deployed"],
    marker: "PolicyStoreId",
  },
  {
    name: "simulate-demand-policy.ts --deployed",
    task: "4.1",
    argv: ["node", "infra/scripts/simulate-demand-policy.ts", "--deployed"],
    marker: "DemandBusName",
  },
];

/** longplay's CDK app and rollback triggers (names.ts, deploy.ts). */
export const LONGPLAY_APP = {
  cdk: ["pnpm", "--filter", "longplay-infra", "exec", "cdk"],
  dir: "infra",
  app: "node bin/platform.ts",
  output: "cdk.out.platform",
  stacks: ["LongplayPlatformStack"],
};
export const LONGPLAY_TRIGGERS = [
  "longplay-platform-plays-dead-letter",
  "longplay-platform-plays-committer-failing",
  "longplay-platform-poller-failing",
  "longplay-platform-parity-failing",
  "longplay-platform-plays-queue-age",
];
