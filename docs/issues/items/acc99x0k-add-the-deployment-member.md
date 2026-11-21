# Add the deployment member

## Problem
longplay deploys its platform through a pipeline it built for itself: check, deploy with rollback triggers, smoke checks, one-off tasks that run once, and a freeze on failure. kiro-remote deploys by hand with scripts/deploy.sh. The software factory needs one deployment model that both projects, and later ones, share, instead of a copy per project.

## Proposal
A new ark member, deployment (@nikovirtala/deployment, CLI and MCP prefix deploy), extracted from longplay's pipeline with every longplay-specific name moved into config: a run as a state machine, the freeze flag, the ledger, deployment tasks in any language behind one executable protocol, the smoke verdict and its runner, the settings schema, provenance as GitHub deployments, and a CDK target as @nikovirtala/deployment/cdk. The design is docs/04-deployment-v1.md.

## Done when
- packages/deployment builds and its unit, property and AWS Emulator tests pass.
- longplay's tests for the moved code pass in the package, adapted to config, and longplay-shaped ledger and freeze records read unchanged.
- The deploy CLI shows status, a task's dry run in each protocol and a frozen pipeline refusing a deploy against the AWS Emulator.
- docs/04-deployment-v1.md records the design, and a changeset releases the package as a prerelease.
