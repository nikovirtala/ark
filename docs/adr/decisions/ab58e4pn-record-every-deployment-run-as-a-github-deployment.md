# Record every deployment run as a GitHub deployment

## Context
Whether a commit is running in an environment is known only inside the project's AWS account (the ledger) today. People and tools look at GitHub, and telemetry has no way to say which commit produced a trace. GitHub's deployment statuses can mark older deployments inactive by themselves (auto_inactive), but not in production environments ([deployment statuses](https://docs.github.com/en/rest/deployments/statuses)), which is where both projects deploy.

## Decision
Each run that passes the freeze flag creates a GitHub deployment for the commit and the environment (required_contexts empty, auto_merge off) and moves its status: in_progress when it starts, error when it refuses, failure when a deploy, smoke check or task fails, success when it succeeds. On success the run marks every earlier deployment of the environment whose latest status is success as inactive, itself, with auto_inactive off. Descriptions hold ids, counts and names only, within GitHub's 140 characters. A GitHub call that fails is logged and never stops the run. The CDK target passes the commit SHA, the repository URL, the environment and the version into the app as context, and the package turns them into the OpenTelemetry resource attributes vcs.ref.head.revision, vcs.repository.url.full, deployment.environment.name and service.version for the deployed stack's telemetry.

## Scope
Provenance in packages/deployment (the GitHub deployment record and the OpenTelemetry attributes from CDK context), and every project's stack that stamps the attributes.

## Consequences
- GitHub shows which commit runs in each environment, and a trace says which commit produced it.
- The project needs a token that may write deployments, kept in Secrets Manager; without one, no deployment is recorded and the log says so.
- A synth without the context (CI) has no attributes, so its template does not change from commit to commit.
