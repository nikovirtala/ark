/**
 * The target contract: what a run needs of the thing it deploys to. Nothing here names
 * CloudFormation: the CDK target (`@nikovirtala/deployment/cdk`) owns its stacks and rollback
 * triggers, and an npm dist-tag target would implement the same three.
 */
import type { StepResult, SynthResult } from "./orchestrate.js";

export interface Target {
  /** Builds what would be deployed, with the settings. A commit that does not synth never deploys. */
  synth(settings: Readonly<Record<string, string>>): Promise<SynthResult>;
  /** Points the environment at this commit, with whatever guards the target has (rollback triggers). */
  deploy(settings: Readonly<Record<string, string>>): Promise<StepResult>;
  /** Points the environment back at `commit`, with the same settings and no guards. */
  rollback(commit: string, settings: Readonly<Record<string, string>>): Promise<StepResult>;
}
