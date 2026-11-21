/**
 * Provenance in a CDK app. The CDK target passes four context keys to `cdk synth` and `cdk deploy`;
 * a stack reads them with `provenanceFromContext(this.node)` and stamps the OpenTelemetry resource
 * attributes into its functions' environment. A synth without them (CI) gets none, so its template
 * does not change from commit to commit.
 */
import { type ProvenanceFacts, provenanceAttributes } from "../provenance.js";

export const PROVENANCE_CONTEXT = {
  commit: "deploymentCommit",
  repositoryUrl: "deploymentRepositoryUrl",
  environment: "deploymentEnvironment",
  version: "deploymentVersion",
} as const;

/** The `-c` arguments that carry the facts into the app. */
export function provenanceContextArgs(facts: ProvenanceFacts): string[] {
  return [
    "-c",
    `${PROVENANCE_CONTEXT.commit}=${facts.commit}`,
    "-c",
    `${PROVENANCE_CONTEXT.repositoryUrl}=${facts.repositoryUrl}`,
    "-c",
    `${PROVENANCE_CONTEXT.environment}=${facts.environment}`,
    "-c",
    `${PROVENANCE_CONTEXT.version}=${facts.version ?? facts.commit}`,
  ];
}

/** What a construct's node offers: `tryGetContext`. A `constructs` Node is one. */
export interface ContextSource {
  tryGetContext(key: string): unknown;
}

/**
 * The OpenTelemetry resource attributes from the app's context, or undefined when the app was
 * synthesized without them (or with only some of them: a half-stamped stack is worse than none).
 */
export function provenanceFromContext(node: ContextSource): Record<string, string> | undefined {
  const get = (key: string): string | undefined => {
    const v = node.tryGetContext(key);
    return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
  };
  const commit = get(PROVENANCE_CONTEXT.commit);
  const repositoryUrl = get(PROVENANCE_CONTEXT.repositoryUrl);
  const environment = get(PROVENANCE_CONTEXT.environment);
  if (!commit || !repositoryUrl || !environment) return undefined;
  const version = get(PROVENANCE_CONTEXT.version);
  return provenanceAttributes({
    commit,
    repositoryUrl,
    environment,
    ...(version ? { version } : {}),
  });
}

export { otelResourceAttributes, provenanceAttributes } from "../provenance.js";
