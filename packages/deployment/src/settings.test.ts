/**
 * longplay's settings tests (infra/test/pipeline-settings.test.ts), moved with the code and adapted to
 * config: longplay's schema is a fixture here (its PLATFORM_SETTINGS, as `[[settings.keys]]` would say
 * it), and the comparison with its deploy.sh stays in longplay. What each test asserts is unchanged.
 */
import { describe, expect, it } from "vitest";
import { contextArgs, parseEnvFile, resolveSettings, type SettingSpec } from "./settings.js";
import { LONGPLAY_SETTINGS } from "./test-support/longplay.js";

const ZONE = "Z063730025TRZH1HLSYPL";
const SITE = "longplayaskappstack-sitebucket397a1860-o9dnefja3b7i";
const REQUIRED = {
  PLATFORM_ALARM_EMAIL: "alarms@example.com",
  PLATFORM_HOSTED_ZONE_ID: ZONE,
  PLATFORM_SITE_BUCKET_NAME: SITE,
};
const resolve = (raw: Record<string, string | undefined>) =>
  resolveSettings(LONGPLAY_SETTINGS, raw);

describe("settings (step 4)", () => {
  it("accepts the required three and turns every set one into a -c argument, in deploy.sh's names", () => {
    const { values, errors } = resolve({
      ...REQUIRED,
      PLATFORM_BUDGET_USD: "30",
      PLATFORM_API_DOMAIN: "",
    });
    expect(errors).toEqual([]);
    // biome-ignore format: pairs
    expect(contextArgs(LONGPLAY_SETTINGS, values)).toEqual([
      "-c", "platformAlarmEmail=alarms@example.com",
      "-c", "platformBudgetUsd=30",
      "-c", `platformHostedZoneId=${ZONE}`,
      "-c", `platformSiteBucketName=${SITE}`,
    ]);
  });

  it("falls back to ALARM_EMAIL for the alarm email, as deploy.sh does", () => {
    expect(
      resolve({ ...REQUIRED, PLATFORM_ALARM_EMAIL: "", ALARM_EMAIL: "old@example.com" }).values
        .PLATFORM_ALARM_EMAIL,
    ).toBe("old@example.com");
  });

  it.each([
    ["PLATFORM_ALARM_EMAIL", /removes the alarm topic's email subscription/],
    ["PLATFORM_HOSTED_ZONE_ID", /removes the API's certificate, domain and DNS record/],
    ["PLATFORM_SITE_BUCKET_NAME", /removes the nightly parity run, its schedule and its alarms/],
  ])(
    "refuses to deploy without %s, with the effect a deploy without it would have",
    (key, effect) => {
      const { errors } = resolve({ ...REQUIRED, [key]: undefined });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(key);
      expect(errors[0]).toMatch(effect);
      expect(resolve({ ...REQUIRED, [key]: "   " }).errors).toHaveLength(1);
    },
  );

  it("refuses a zone id or a bucket name of the wrong shape", () => {
    expect(
      resolve({ ...REQUIRED, PLATFORM_HOSTED_ZONE_ID: `/hostedzone/${ZONE}` }).errors[0],
    ).toContain("without /hostedzone/");
    expect(resolve({ ...REQUIRED, PLATFORM_SITE_BUCKET_NAME: "Not_A_Bucket" }).errors[0]).toContain(
      "bucket name",
    );
  });
});

describe("what the schema adds for other projects", () => {
  const specs: SettingSpec[] = [
    { key: "DNS_ZONE_NAME", context: "dnsZoneName", default: "example.dev" },
    { key: "CUSTOM_DOMAIN_NAME", context: "customDomainName", default: "example.dev" },
    {
      key: "HOSTED_ZONE_ID",
      context: "hostedZoneId",
      required: "Without it the domain switches to manual CNAMEs, deleting its records.",
      requiredWhen: ["DNS_ZONE_NAME", "CUSTOM_DOMAIN_NAME"],
    },
  ];

  it("fills a blank setting from its default, as the deploy script does", () => {
    expect(resolveSettings(specs, { HOSTED_ZONE_ID: "Z1" }).values).toEqual({
      DNS_ZONE_NAME: "example.dev",
      CUSTOM_DOMAIN_NAME: "example.dev",
      HOSTED_ZONE_ID: "Z1",
    });
  });

  it("requires a setting only when the settings it depends on are set (after defaults), and says why", () => {
    const { errors } = resolveSettings(specs, {});
    expect(errors).toEqual([
      "HOSTED_ZONE_ID is not set (required because DNS_ZONE_NAME and CUSTOM_DOMAIN_NAME are set). Without it the domain switches to manual CNAMEs, deleting its records.",
    ]);
    const off: SettingSpec[] = specs.map((s) =>
      s.key === "HOSTED_ZONE_ID" ? s : { key: s.key, context: s.context },
    );
    expect(resolveSettings(off, { DNS_ZONE_NAME: "z" }).errors).toEqual([]);
  });
});

describe("reading a deploy.env", () => {
  it("reads KEY=value lines the way a shell would: comments, export, quotes, trailing comments", () => {
    const parsed = parseEnvFile(`# a comment
PLATFORM_ALARM_EMAIL=alarms@example.com
export PLATFORM_BUDGET_USD=30
PLATFORM_API_DOMAIN="api.example.com"
PLATFORM_TABLE_BUCKET_SUFFIX='abc'
PLATFORM_COGNITO_DOMAIN_PREFIX=longplay   # trailing comment
# PLATFORM_API_DOMAIN=ignored.example.com
EMPTY=
not a setting line`);
    expect(parsed).toEqual({
      PLATFORM_ALARM_EMAIL: "alarms@example.com",
      PLATFORM_BUDGET_USD: "30",
      PLATFORM_API_DOMAIN: "api.example.com",
      PLATFORM_TABLE_BUCKET_SUFFIX: "abc",
      PLATFORM_COGNITO_DOMAIN_PREFIX: "longplay",
      EMPTY: "",
    });
  });
});
