# Extract the deployment pipeline into an ark member, deployment

## Context
longplay deploys its platform through a pipeline it built for itself (infra/pipeline/ in longplay): check, deploy with rollback triggers, smoke checks, one-off tasks run once, and a freeze on failure. kiro-remote deploys by hand with scripts/deploy.sh, and the next projects would copy longplay's code. Copies drift: a fix to the freeze path would reach one project and not the others. ark already keeps shared machinery in one package (ledger) for the same reason. See [the design](../../04-deployment-v1.md).

## Decision
Deployment becomes an ark member: the package @nikovirtala/deployment, with the CLI and MCP prefix deploy and the CDK target at the subpath @nikovirtala/deployment/cdk. Every name longplay hard-codes (the ledger table, the freeze parameter, the task key prefix, the role names, the task directory and the task environment variables) is a setting in the project's deploy.toml, so longplay's existing ledger items and freeze value read unchanged and its Python tasks run as they are. Every AWS and GitHub call goes through an injected port. Projects keep their own pipeline stack, smoke checks and tasks. A deployment points an environment at a version; making versioned artifacts is a separate member, release.

## Scope
packages/deployment and every project that deploys with it: its deploy.toml, its pipeline stack and its tasks directory.

## Consequences
- A fix to the run reaches every project with a version bump.
- The package's records are a public contract: changing a key or a field is a breaking change for every project's ledger.
- longplay moves onto the package in a later change; until then it runs its own copy, and the package's tests carry longplay-shaped fixtures so the two cannot diverge unnoticed.
- The package is not built on ledger: its records live in DynamoDB and SSM in each project's account, not in git.
