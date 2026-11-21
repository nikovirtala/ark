# @nikovirtala/deployment

Deploy a project's environment from its pipeline: check, deploy with rollback triggers, smoke checks, one-off deployment tasks run once, and a freeze on failure. Extracted from longplay's platform pipeline; the design is [docs/04-deployment-v1.md](https://github.com/nikovirtala/ark/blob/main/docs/04-deployment-v1.md).

**Requirements:** Node 24 or newer, the AWS CLI v2 in the pipeline's build, and the CDK CLI in the project for the CDK target. Released at 0.x as a prerelease: the API can change until 1.0.

## Entries

- `@nikovirtala/deployment`: the run (`orchestrate`, the state machine in `TRANSITIONS`), the freeze flag (`FreezeStore`), the ledger (`Ledger`), the settings, the task runner and protocol, the smoke verdict, runner and helpers, provenance (`GitHubProvenance`), the read side (`deploymentStatus`, `listTasks`, `validateTask`, `planRun`, `environments`) and the typed, versioned records (`FreezeRecord`, `RunRecord`).
- `@nikovirtala/deployment/cdk`: the CDK target (`CdkTarget`, `cdkArgs`), the rollback-trigger selection (`selectRollbackTriggers`, `listExistingAlarms`) and provenance in a CDK app (`provenanceFromContext`, `otelResourceAttributes`). It imports nothing from aws-cdk-lib.
- `@nikovirtala/deployment/testing`: `MemoryFreeze`, `MemoryLedger` and `MemoryGitHub`, for a project's own tests.
- The `deploy` binary.

## The CLI

```sh
deploy status                        # frozen or not, the last good commit, the last runs, the tasks
deploy settings [--env-file F]       # copy deploy.env's settings into SSM (refuses without a REQUIRED one)
deploy freeze "<reason>"             # stop merges from deploying
deploy unfreeze                      # clear the freeze flag, after fixing what froze it
deploy tasks [--check]               # the deployment tasks and which are done (--check: validate each)
deploy dry-run                       # what a run would do now; changes nothing
deploy dry-run <task>                # one task's dry run, with your credentials
deploy run                           # one pipeline run: the build's main step
deploy run <task>                    # one task by hand: dry run first, recorded in the ledger
deploy forget <task>                 # put a done task back to pending
```

`--json` prints one JSON document, and `--config <file>` names a `deploy.toml` other than the one found from the working directory upwards. Exit 0 on success, 1 on a failed or refused run, 2 on a usage or config error. With `ARK_AGENT` set, `run`, `unfreeze`, `forget` and `settings` refuse: agents read deployments and never deploy, unfreeze or forget.

## deploy.toml

Every name the run uses is in the project's `deploy.toml` at its repository root:

| Table | Keys |
| --- | --- |
| `[project]` | `name`, `region`, `environment` (default `production`), `repository` (`owner/repo`) |
| `[pipeline]` | `name`: the CodePipeline pipeline, for the console link of a run |
| `[hints]` | `unfreeze`, `settings`: the commands the notifications name (default `deploy unfreeze`, `deploy settings`) |
| `[ledger]` | `table`, `task_key_prefix` (default `TASK#`) |
| `[freeze]` | `parameter`: the SSM parameter |
| `[settings]` | `prefix`, and `[[settings.keys]]` with `key`, `context`, `required` (the effect a deploy without it would have), `required_when`, `pattern`, `pattern_hint`, `default`, `fallback` |
| `[roles]` | `deploy`, `smoke`, `task_prefix`, and any other role a smoke command runs as |
| `[notify]` | `topic`: the SNS topic a failed run publishes to |
| `[tasks]` | `dir` (default `tasks`), `interpreters` (`".py" = ["python3"]`), `env` (the project's own names for the commit and the outputs), `outputs_stack` |
| `[smoke]` | `command`, `markers` (task to marker output), `[[smoke.before]]`, `[[smoke.after]]` |
| `[[preflight]]` | `kind` = `secret`, `bucket`, `stack` or `command`, run as the deploy role before anything is deployed |
| `[target]` | `kind = "cdk"`, `cdk` (the command), `dir`, `app`, `output`, `stacks`, `rollback_triggers`, `alarm_prefix`, `monitoring_minutes`, `install` |
| `[provenance]` | `github_token_secret`: the Secrets Manager secret with a token that may write deployments |

## Deployment tasks

A task is a file in the tasks directory named `<n>[.<m>]-<slug>[.<ext>]`, run in numeric order, once. It is any executable that answers `--needs` with one JSON line (`{"role": "...", "description": "...", "outputs": ["..."]}`) and `--dry-run` and `--run` with a last line `{"summary": "..."}`; a non-zero exit is a failure. It runs as the role it declares (one with the `task_prefix`, never the deploy role), with the commit in `DEPLOY_TASK_COMMIT` and its outputs as JSON in `DEPLOY_TASK_OUTPUTS`. A TypeScript module that exports `needs`, `dryRun(ctx)` and `run(ctx)` is run by the package's shim in its own process.

## Smoke checks

A project's checks are a list of `SmokeCheck`s, and its check script ends with `process.exitCode = await smokeMain(CHECKS, { region })`. `--json` prints the results for the pipeline, `--dry-run` prints each check's calls without making them. In a run, the check command also gets `DEPLOY_COMMIT` and `DEPLOY_ENVIRONMENT`, so a check can compare what it finds with what was deployed. The run fails on every FAIL, and on a SKIP whose task's marker output is in the template it deployed.

## Provenance

Each run past the freeze flag records a GitHub deployment for its commit and environment and moves its status. The CDK target passes `deploymentCommit`, `deploymentRepositoryUrl`, `deploymentEnvironment` and `deploymentVersion` as context; a stack stamps them into its functions:

```ts
import { otelResourceAttributes, provenanceFromContext } from "@nikovirtala/deployment/cdk";

const attributes = provenanceFromContext(this.node); // undefined in a synth without the context
if (attributes) fn.addEnvironment("OTEL_RESOURCE_ATTRIBUTES", otelResourceAttributes(attributes));
```
