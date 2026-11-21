/**
 * A project's deploy settings: the non-secret values its deploy script reads from `deploy.env`, here
 * read from SSM Parameter Store (`<prefix><KEY>`, String) so the pipeline needs no file.
 *
 * The schema is in the repository (`[[settings.keys]]` in `deploy.toml`): each setting's key, the CDK
 * context key it becomes, an optional pattern, default and fallback, and REQUIRED with the effect a
 * deploy without it would have. A REQUIRED setting is one whose absence would delete something on
 * deploy, so the pipeline refuses to deploy without it instead.
 *
 * Secrets are not settings: a setting may name a secret (an ARN), never hold its value.
 */
import {
  DeleteParametersCommand,
  GetParametersByPathCommand,
  PutParameterCommand,
} from "@aws-sdk/client-ssm";
import type { SsmPort } from "./freeze.js";

export interface SettingSpec {
  /** The key in `deploy.env` and the last segment of the SSM parameter name. */
  readonly key: string;
  /** The CDK context key (or the target's own name for it) the value is passed as. */
  readonly context: string;
  /** Refuse to deploy without it, with the effect a deploy without it would have. */
  readonly required?: string;
  /** Required only when every one of these keys has a value (after defaults). Needs `required`. */
  readonly requiredWhen?: readonly string[];
  /** Accepted shape. */
  readonly pattern?: RegExp;
  readonly patternHint?: string;
  /** The value when the setting is blank, as the deploy script defaults it. */
  readonly default?: string;
  /** Another key whose value is used when this one is blank (longplay's ALARM_EMAIL). */
  readonly fallback?: string;
}

export type Values = Readonly<Record<string, string | undefined>>;

export interface ResolvedSettings {
  /** The settings by key, only those with a value. */
  readonly values: Readonly<Record<string, string>>;
  /** Why the pipeline must refuse to deploy. Empty = fine. */
  readonly errors: readonly string[];
}

/** Applies the schema: blank is unset, then the fallback key, then the default; REQUIRED and patterns are checked. */
export function resolveSettings(specs: readonly SettingSpec[], raw: Values): ResolvedSettings {
  const get = (key: string): string => (raw[key] ?? "").trim();
  const resolved = new Map<string, string>();
  for (const spec of specs) {
    let value = get(spec.key);
    if (value === "" && spec.fallback) value = get(spec.fallback);
    if (value === "" && spec.default !== undefined) value = spec.default;
    if (value !== "") resolved.set(spec.key, value);
  }
  const values: Record<string, string> = {};
  const errors: string[] = [];
  for (const spec of specs) {
    const value = resolved.get(spec.key);
    if (value === undefined) {
      const applies = (spec.requiredWhen ?? []).every((k) => resolved.has(k));
      if (spec.required && applies) {
        const when =
          spec.requiredWhen && spec.requiredWhen.length > 0
            ? ` (required because ${spec.requiredWhen.join(" and ")} ${spec.requiredWhen.length === 1 ? "is" : "are"} set)`
            : "";
        errors.push(`${spec.key} is not set${when}. ${spec.required}`);
      }
      continue;
    }
    if (spec.pattern && !spec.pattern.test(value)) {
      errors.push(`${spec.key} is not ${spec.patternHint ?? "well formed"}: ${value}`);
      continue;
    }
    values[spec.key] = value;
  }
  return { values, errors };
}

/** The `-c key=value` arguments of `cdk` for the resolved settings, in schema order. */
export function contextArgs(
  specs: readonly SettingSpec[],
  values: Readonly<Record<string, string>>,
): string[] {
  const args: string[] = [];
  for (const spec of specs) {
    const value = values[spec.key];
    if (value !== undefined && value !== "") args.push("-c", `${spec.context}=${value}`);
  }
  return args;
}

/** Reads a `deploy.env` file the way a shell would for plain `KEY=value` lines: comments, `export`, and one pair of quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let value = (m[2] ?? "").trim();
    const quoted = /^(["'])(.*)\1/.exec(value);
    if (quoted) value = quoted[2] ?? "";
    else value = value.replace(/\s+#.*$/, "");
    out[m[1] as string] = value;
  }
  return out;
}

export function settingParameterName(prefix: string, key: string): string {
  return `${prefix}${key}`;
}

/** Reads every setting parameter under the prefix. Values are plain strings: a setting is never a secret. */
export async function readSettings(ssm: SsmPort, prefix: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let token: string | undefined;
  do {
    const page = await ssm.send(
      new GetParametersByPathCommand({
        Path: prefix,
        Recursive: false,
        ...(token ? { NextToken: token } : {}),
      }),
    );
    for (const p of page.Parameters ?? []) {
      if (p.Name && p.Value !== undefined) out[p.Name.slice(prefix.length)] = p.Value;
    }
    token = page.NextToken;
  } while (token);
  return out;
}

export interface PublishResult {
  readonly written: readonly string[];
  readonly removed: readonly string[];
}

/**
 * Copies the settings of a `deploy.env` into SSM and removes parameters that the file no longer
 * sets, so SSM says what the deploy script would pass. Refuses (writes nothing) when a REQUIRED
 * setting is missing, so the pipeline can never be left with settings it would refuse. A value equal
 * to the setting's default is stored too, so SSM says what is deployed without the schema.
 */
export async function publishSettings(
  ssm: SsmPort,
  prefix: string,
  specs: readonly SettingSpec[],
  env: Values,
): Promise<PublishResult> {
  const { values, errors } = resolveSettings(specs, env);
  if (errors.length > 0) throw new Error(`not publishing: ${errors.join(" ")}`);
  const written: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    await ssm.send(
      new PutParameterCommand({
        Name: settingParameterName(prefix, key),
        Value: value,
        Type: "String",
        Overwrite: true,
        Description: "Deploy setting (copied from deploy.env by deploy settings)",
      }),
    );
    written.push(key);
  }
  const existing = Object.keys(await readSettings(ssm, prefix));
  const stale = existing.filter((k) => !(k in values));
  // DeleteParameters takes at most 10 names.
  for (let i = 0; i < stale.length; i += 10) {
    await ssm.send(
      new DeleteParametersCommand({
        Names: stale.slice(i, i + 10).map((k) => settingParameterName(prefix, k)),
      }),
    );
  }
  return { written, removed: stale };
}
