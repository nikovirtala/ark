/**
 * A project's `deploy.toml`: every name the run uses, the settings schema, the target, the smoke
 * stage and the tasks. Validated with Zod when it is loaded; every key has a default only where the
 * projects on the package agree.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { DEFAULT_TASK_KEY_PREFIX } from "./ledger.js";
import type { RunHints } from "./orchestrate.js";
import type { SettingSpec } from "./settings.js";
import type { SmokeCommand } from "./smoke/stage.js";

export const CONFIG_FILE = "deploy.toml";

const name = z.string().min(1);
const argv = z.array(z.string().min(1)).min(1);

const settingSchema = z
  .object({
    key: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    context: name,
    required: z.string().min(1).optional(),
    required_when: z.array(name).optional(),
    pattern: z.string().optional(),
    pattern_hint: z.string().optional(),
    default: z.string().optional(),
    fallback: name.optional(),
  })
  .strict()
  .refine((s) => s.required_when === undefined || s.required !== undefined, {
    message: "required_when needs required (the effect a deploy without it would have)",
  });

const smokeCommandSchema = z
  .object({
    name,
    task: name,
    argv,
    role: name.optional(),
    env: z.record(z.string(), z.string()).optional(),
    marker: name.optional(),
  })
  .strict();

const preflightSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("secret"), setting: name.optional(), name: name.optional() }).strict(),
  z.object({ kind: z.literal("bucket"), setting: name.optional(), name: name.optional() }).strict(),
  z.object({ kind: z.literal("stack"), name }).strict(),
  z.object({ kind: z.literal("command"), argv, why: name }).strict(),
]);

export const configSchema = z
  .object({
    project: z
      .object({
        name,
        region: name,
        environment: name.default("production"),
        /** `owner/repo` on GitHub. */
        repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
      })
      .strict(),
    pipeline: z
      .object({
        /** The CodePipeline pipeline, for the console link of a run. */
        name: name.optional(),
      })
      .strict()
      .default({}),
    hints: z
      .object({
        unfreeze: name.default("deploy unfreeze"),
        settings: name.default("deploy settings"),
      })
      .strict()
      .default({ unfreeze: "deploy unfreeze", settings: "deploy settings" }),
    ledger: z
      .object({ table: name, task_key_prefix: name.default(DEFAULT_TASK_KEY_PREFIX) })
      .strict(),
    freeze: z.object({ parameter: z.string().regex(/^\/.+/) }).strict(),
    settings: z
      .object({
        prefix: z.string().regex(/^\/.*\/$/),
        keys: z.array(settingSchema).default([]),
      })
      .strict(),
    roles: z.object({ deploy: name, smoke: name, task_prefix: name }).catchall(name),
    notify: z.object({ topic: name.optional() }).strict().default({}),
    tasks: z
      .object({
        dir: name.default("tasks"),
        interpreters: z.record(z.string().regex(/^\.[A-Za-z0-9]+$/), argv).default({}),
        env: z.object({ commit: name, outputs: name }).strict().optional(),
        /** The stack whose outputs tasks may ask for. Default: the target's last stack. */
        outputs_stack: name.optional(),
      })
      .strict()
      .default({ dir: "tasks", interpreters: {} }),
    smoke: z
      .object({
        command: argv,
        markers: z.record(z.string(), name).default({}),
        before: z.array(smokeCommandSchema).default([]),
        after: z.array(smokeCommandSchema).default([]),
      })
      .strict(),
    preflight: z.array(preflightSchema).default([]),
    target: z
      .object({
        kind: z.literal("cdk"),
        cdk: argv,
        dir: name.default("."),
        app: name.optional(),
        output: name.default("cdk.out.deploy"),
        stacks: z.array(name).min(1),
        rollback_triggers: z.array(name).max(100).default([]),
        alarm_prefix: name.optional(),
        monitoring_minutes: z.number().int().min(0).max(180).default(10),
        install: argv.default(["pnpm", "install", "--frozen-lockfile"]),
      })
      .strict(),
    provenance: z
      .object({
        /** The Secrets Manager secret with a GitHub token that may write deployments. */
        github_token_secret: name.optional(),
        production: z.boolean().optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export type RawConfig = z.infer<typeof configSchema>;

export type PreflightCheck = RawConfig["preflight"][number];

/** The config as the run uses it: the settings schema compiled, the names in one place. */
export interface DeploymentConfig {
  readonly raw: RawConfig;
  /** The directory `deploy.toml` is in: the repository root. */
  readonly root: string;
  readonly project: RawConfig["project"];
  readonly hints: RunHints;
  readonly specs: readonly SettingSpec[];
  readonly smokeBefore: readonly SmokeCommand[];
  readonly smokeAfter: readonly SmokeCommand[];
  readonly tasksDir: string;
  readonly outputsStack: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function toSpec(s: RawConfig["settings"]["keys"][number]): SettingSpec {
  let pattern: RegExp | undefined;
  if (s.pattern !== undefined) {
    try {
      pattern = new RegExp(s.pattern);
    } catch (err) {
      throw new ConfigError(
        `settings key ${s.key}: the pattern is not a regular expression (${(err as Error).message})`,
      );
    }
  }
  return {
    key: s.key,
    context: s.context,
    ...(s.required !== undefined ? { required: s.required } : {}),
    ...(s.required_when !== undefined ? { requiredWhen: s.required_when } : {}),
    ...(pattern ? { pattern } : {}),
    ...(s.pattern_hint !== undefined ? { patternHint: s.pattern_hint } : {}),
    ...(s.default !== undefined ? { default: s.default } : {}),
    ...(s.fallback !== undefined ? { fallback: s.fallback } : {}),
  };
}

const toCommand = (c: RawConfig["smoke"]["before"][number]): SmokeCommand => ({
  name: c.name,
  task: c.task,
  argv: c.argv,
  ...(c.role !== undefined ? { role: c.role } : {}),
  ...(c.env !== undefined ? { env: c.env } : {}),
  ...(c.marker !== undefined ? { marker: c.marker } : {}),
});

/** Validates a parsed `deploy.toml`. Throws a ConfigError that names every problem. */
export function parseConfig(value: unknown, root: string): DeploymentConfig {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigError(
      `${CONFIG_FILE} is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    );
  }
  const raw = parsed.data;
  const keys = new Set<string>();
  for (const s of raw.settings.keys) {
    if (keys.has(s.key)) throw new ConfigError(`settings key ${s.key} is listed twice`);
    keys.add(s.key);
  }
  for (const s of raw.settings.keys) {
    // A fallback may be a key the deploy script reads that is not a setting (longplay's ALARM_EMAIL).
    for (const k of s.required_when ?? []) {
      if (!keys.has(k))
        throw new ConfigError(
          `settings key ${s.key} is required when ${k} is set, but ${k} is not a setting`,
        );
    }
  }
  for (const c of [...raw.smoke.before, ...raw.smoke.after]) {
    if (c.role !== undefined && !(c.role in raw.roles)) {
      throw new ConfigError(
        `smoke command ${c.name} runs as role ${c.role}, which is not in [roles]`,
      );
    }
  }
  return {
    raw,
    root,
    project: raw.project,
    hints: raw.hints,
    specs: raw.settings.keys.map(toSpec),
    smokeBefore: raw.smoke.before.map(toCommand),
    smokeAfter: raw.smoke.after.map(toCommand),
    tasksDir: path.resolve(root, raw.tasks.dir),
    outputsStack: raw.tasks.outputs_stack ?? (raw.target.stacks.at(-1) as string),
  };
}

/** Finds `deploy.toml` from `start` upwards, or reads the file given. */
export function loadConfig(file?: string, start: string = process.cwd()): DeploymentConfig {
  let found = file ? path.resolve(file) : undefined;
  if (!found) {
    for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, CONFIG_FILE);
      if (fs.existsSync(candidate)) {
        found = candidate;
        break;
      }
      if (path.dirname(dir) === dir) break;
    }
  }
  if (!found || !fs.existsSync(found))
    throw new ConfigError(`no ${CONFIG_FILE} here or in a parent directory`);
  let value: unknown;
  try {
    value = parseToml(fs.readFileSync(found, "utf8"));
  } catch (err) {
    throw new ConfigError(`${found}: ${(err as Error).message}`);
  }
  return parseConfig(value, path.dirname(found));
}

/** The console link of a pipeline execution, when the pipeline is named. */
export function logsUrl(config: DeploymentConfig, execution: string): string {
  const p = config.raw.pipeline.name;
  const r = config.project.region;
  if (!p || execution === "manual") return "-";
  return `https://${r}.console.aws.amazon.com/codesuite/codepipeline/pipelines/${p}/executions/${execution}/timeline?region=${r}`;
}
