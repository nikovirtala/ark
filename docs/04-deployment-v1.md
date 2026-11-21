# deployment: Design Doc

Nov 21, 2026 · drafted by Kiro for @Niko Virtala

## Context and scope

longplay deploys its platform through a pipeline it built for itself: every merge to `main` runs the checks, deploys with CloudFormation rollback triggers, runs smoke checks, runs the one-off steps that are pending, and on a failure rolls back and freezes itself until a person clears the flag. kiro-remote deploys by hand with `scripts/deploy.sh`. The next projects would copy longplay's code, and the copies would drift the way adr's and issues' machinery would have before ledger.

This design makes that pipeline one ark member, **deployment**, and moves kiro-remote onto it as the second project. A deployment points an environment at a version. Making versioned artifacts is **release**, a separate member later. The design covers the package's contracts, its run semantics, its records and what agents may do with it. It does not cover longplay's move onto the package, the MCP server, the npm dist-tag target, draft's deployment kind or the release member; each is listed under [Work](#work) and the contracts here are shaped so they fit.

## Why a design doc

The semantics are already proven in longplay, so the risk is not in what a run does but in what becomes config. Every name longplay hard-codes (the ledger table, the freeze parameter, the `RELEASE#` keys, the `longplay-release-` role prefix, the Python environment variables) must become a project setting without changing a single decision longplay's run makes. Getting that boundary wrong either leaks longplay into the package or breaks longplay's records when it moves.

## Goals and non-goals

**Goals**

- One implementation of the run: check, deploy, smoke, tasks, rollback, freeze, with longplay's semantics unchanged.
- Every project-specific name is config, so longplay's existing ledger items and freeze value read unchanged and its Python tasks run as they are.
- Deployment tasks in any language, through one executable protocol.
- Status, run records, task listing and validation as library functions, so a read-only MCP server is a thin layer over them.
- A target contract with no CloudFormation in it, so an npm dist-tag target fits next to CDK.
- Typed, versioned and exported freeze and run records, so draft can read them.

**Non-goals**

- Making versioned artifacts (the release member).
- A hosted service. Each project's pipeline, ledger and freeze flag live in its own AWS account.
- Letting an agent deploy, unfreeze or forget.
- Building the pipeline stack for a project. The package ships the run and its helpers; each project keeps its own CodePipeline stack, because its roles name its own resources.

## Overview

A project keeps a `deploy.toml` at its repository root: its names, its settings schema, its target, its smoke command and its tasks directory. Its pipeline (CodePipeline V2 with one CodeBuild action, as in longplay) checks the freeze flag before it installs anything, runs the project's checks, then runs `deploy run`. That one process drives the run as a state machine, assuming a separate role for each kind of work. People use the same CLI from their own machines for `status`, `settings`, `freeze`, `unfreeze`, `tasks`, `dry-run`, `run <task>` and `forget`.

```text
queued ──frozen flag──▶ frozen (nothing touched)
  │
  ▼
preflight ──missing setting, failed preflight, synth fails──▶ refused (nothing deployed, nothing frozen)
  │
  ▼
deploying ──fails──▶ set the freeze flag ─▶ roll back to the last good commit ─▶ frozen
  │
  ▼
smoking ──fails──▶ set the freeze flag ─▶ roll back to the last good commit ─▶ frozen
  │
  ▼
running tasks ──fails──▶ set the freeze flag ─▶ frozen (no rollback)
  │
  ▼
succeeded (the commit is the last good one)
```

Only a person leaves `frozen`, with `deploy unfreeze`. The machine has no transition out of it.

## Detailed design

### Names

| Thing | Name |
| --- | --- |
| Member and package | deployment, `@nikovirtala/deployment` |
| CLI and MCP prefix | `deploy` (`deploy status`, later `deploy_status`) |
| CDK target | `@nikovirtala/deployment/cdk` |
| One-off steps after a deploy | deployment tasks, in `tasks/` |
| Project config | `deploy.toml` at the repository root |

longplay keeps `release/` and its `RELEASE#<id>` ledger keys through config (`[tasks] dir = "release"`, `[ledger] task_key_prefix = "RELEASE#"`).

### The run as a state machine

The phases are `queued`, `preflight`, `deploying`, `smoking`, `running-tasks`, and the terminal `succeeded`, `refused` and `frozen`. The transitions are data (`TRANSITIONS` in `machine.ts`), each with the effects it has: set the freeze flag, roll back, notify, record the last good commit. `orchestrate()` walks it with injected steps, and the property tests drive it with arbitrary step outcomes.

The rules, all from longplay's `orchestrate.ts`:

- The freeze flag is read first. Set, or unreadable, ends the run in `frozen` with nothing deployed, checked or run, and without a notification (one went out when it froze).
- A refusal before `deploying` (a REQUIRED setting is missing or malformed, a preflight finds a resource missing, the synth fails) changes nothing and freezes nothing. The next merge tries again.
- A failed deploy or smoke sets the freeze flag **first**, then deploys the last good commit with the same settings and no rollback triggers, then notifies. A build that dies during the rollback still leaves the pipeline frozen.
- A failed task sets the freeze flag and does **not** roll back: tasks move data forward, and an older commit does not undo them.
- A step that throws is a failure of that step, never a crash of the run. A notification or ledger write that fails is logged and the run goes on.

The run record keeps longplay's outcomes (`frozen`, `refused`, `check-failed`, `rolled-back`, `rollback-failed`, `task-failed`, `succeeded`) and adds the terminal phase. longplay's `release-failed` reads as `task-failed`.

### Contracts

**Target.** `synth(settings)` returns whether it synthesized, a one-line detail and the output keys of what would be deployed; `deploy(settings)` and `rollback(commit, settings)` return whether they worked. Nothing in the contract names CloudFormation. The CDK target (`@nikovirtala/deployment/cdk`) runs `cdk synth` and `cdk deploy` with the settings as `-c` flags and owns the rollback triggers: at most five alarms, each OK when the deploy starts and not in ALARM within the last hour, with the missing ones left out and logged, because a missing alarm fails the whole deploy ([rollback triggers](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-rollback-triggers.html), [cdk deploy](https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-deploy.html)). The rollback checks out the last good commit in a `git worktree`, installs it and deploys it without triggers.

**Deployment task.** A task is a file in the tasks directory named `<n>[.<m>…]-<slug>[.<ext>]`, run in numeric order. It is any executable that answers three flags:

| Flag | Prints | Exit |
| --- | --- | --- |
| `--needs` | one JSON line: `{"role": "...", "description": "...", "outputs": ["..."]}` | 0 |
| `--dry-run` | anything, then a last line `{"summary": "..."}`; changes nothing | 0, non-zero on failure |
| `--run` | anything, then a last line `{"summary": "..."}` | 0, non-zero on failure |

It gets the declared role's keys in its environment, and the commit and the stack outputs it declared in two variables (`DEPLOY_TASK_COMMIT`, `DEPLOY_TASK_OUTPUTS`; longplay sets `LP_RELEASE_COMMIT` and `LP_RELEASE_OUTPUTS`). An extension can map to an interpreter (`".py" = ["uv", "run", "--frozen", "--directory", "transform", "python"]` in longplay), and a file without one must be executable. A TypeScript module that exports `needs`, `dryRun(ctx)` and `run(ctx)` is a convenience: the package's shim runs it in its own Node process and speaks the same protocol, so it too sees only its role's keys. The runner dry-runs each pending task, runs it, records both in the ledger, and stops at the first failure. A task's role must start with the project's task role prefix, never the deploy role. A task in the ledger never runs again, and the ledger's `DONE` item is written with a condition, so two runs at once cannot both count it.

**Smoke check.** A check returns PASS, FAIL, INFO or SKIP with a task and a name. Checks stay in the project; the package owns the verdict (every FAIL fails the run; a SKIP fails unless the task's marker output is absent from the template that was deployed; a crashed or unparseable check fails), the runner that runs a project's check list and prints JSON, the stage that runs the check command as the smoke role (with optional commands before and after it, such as longplay's `record-test-run.ts` and its `--deployed` policy simulations), and the helpers that are general: `readOnlyAws` with its describe/get/list rule, `isNotFound`, `describeStack` and `changedWithin` (a scheduled job that has not run yet on its first deploy is INFO, never FAIL). The rest of longplay's `verify-platform.ts` is longplay's.

**Settings.** The schema is in the repository: each setting has its key, its CDK context key, an optional pattern with a hint, an optional default and fallback key, and REQUIRED with the effect a deploy without it would have (`required_when` makes it conditional on other settings being set). The values live in SSM Parameter Store as String parameters under a prefix, copied from the project's `deploy.env` by `deploy settings`, which refuses and writes nothing when a REQUIRED one is missing. Secrets are never settings: a setting may name a secret, never hold it.

**Ledger.** One DynamoDB table per project, in its account, outside the deployed stack, so a destroy of the stack keeps it. The keys are longplay's: `<task prefix><id>` with `DONE` and `ATTEMPT#<time>`, and `DEPLOY` with `LAST_GOOD` and `RUN#<time>`. Records read from longplay's table unchanged; new ones add a `schema` field.

**Freeze.** One SSM parameter. Absent means the pipeline may deploy. Present means frozen, and its value is a JSON freeze record. Reading fails closed: any error other than "does not exist" counts as frozen, and a value that isn't a freeze record is frozen too.

**Records.** `FreezeRecord` (`deployment-freeze/v1`: reason, commit, at, logs, rolledBackTo, by) and `RunRecord` (`deployment-run/v1`: commit, at, execution, outcome, phase, summary, environment, deployment) are exported types with parse functions that accept longplay's unversioned items.

### Provenance

Each run that passes the freeze flag creates a GitHub deployment for the commit and the environment, with `required_contexts: []` and `auto_merge: false`, and moves its status: `in_progress` when the run starts, `error` when it refuses (nothing was deployed), `failure` when a deploy, smoke check or task fails, and `success` when it succeeds. On success the run sets every earlier deployment of the environment whose latest status is `success` to `inactive`. GitHub's own `auto_inactive` does not do this for production environments ([deployment statuses](https://docs.github.com/en/rest/deployments/statuses)), so the run does it and passes `auto_inactive: false`. A provenance call that fails is logged and the run goes on: GitHub being down must not stop a deploy. The GitHub API is a port; the token is read from Secrets Manager by the project's wiring.

The CDK target passes the commit SHA, the repository URL, the environment and the version (the commit, unless the project sets one) into the app as context (`deploymentCommit`, `deploymentRepositoryUrl`, `deploymentEnvironment`, `deploymentVersion`). `provenanceFromContext(node)` turns them into the OpenTelemetry resource attributes `vcs.ref.head.revision`, `vcs.repository.url.full`, `deployment.environment.name` and `service.version`, and `otelResourceAttributes()` formats them for `OTEL_RESOURCE_ATTRIBUTES`. A synth without the context (CI) gets none, so its template does not change from commit to commit.

### Agents read, people act

The CLI has `status`, `settings`, `freeze`, `unfreeze`, `tasks`, `dry-run`, `run` and `forget`. `run` with no argument is one pipeline run, the build's main step; `run <task>` runs one task by hand. `dry-run` with no argument shows what a run would do (the freeze flag, the settings verdict, the pending tasks) and changes nothing; `dry-run <task>` is one task's dry run. The MCP server that comes next is read-only (`deploy_status`, `deploy_run`, `deploy_tasks`, `deploy_environments`, `deploy_validate_task`, `deploy_simulate`, `deploy_check_smoke`), and each tool is one of the library functions the CLI already calls. Nothing an agent can call deploys, unfreezes or forgets; in the projects, an agent's AWS access is read-only and the work roles trust the pipeline's runner only.

### Everything stays in the account

What checks and tasks print may hold a project's data, and it stays in the build's CloudWatch log group. Summaries, ledger records, freeze records, notifications and GitHub deployment descriptions hold ids, counts and names only, and are clipped (1,000 characters in the ledger, 140 on GitHub).

### Configuration

```toml
# deploy.toml
[project]
name = "kiro-remote"
region = "eu-north-1"
environment = "production"
repository = "nikovirtala/kiro-remote"

[pipeline]
name = "kiro-remote-deploy"           # for the console link of a run

[ledger]
table = "kiro-remote-deployment-ledger"

[freeze]
parameter = "/kiro-remote/deployment/frozen"

[roles]
deploy = "kiro-remote-deployment-deploy"
smoke = "kiro-remote-deployment-smoke"
task_prefix = "kiro-remote-deployment-task-"

[target]
kind = "cdk"
stacks = ["KiroRemoteDnsStack", "KiroRemoteStack"]

[smoke]
command = ["node", "scripts/smoke.ts"]

[settings]
prefix = "/kiro-remote/deployment/settings/"

[[settings.keys]]
key = "KIRO_API_KEY_SECRET_ARN"
context = "kiroApiKeySecretArn"
required = "Without it the stack creates an empty Kiro API key secret, which is deleted on rollback."
```

The schema is validated with Zod when it is loaded, and every key the package reads has a default only where longplay and kiro-remote agree.

### Package layout

| Path | Holds |
| --- | --- |
| `src/machine.ts`, `src/orchestrate.ts` | the state machine and the run |
| `src/records.ts`, `src/freeze.ts`, `src/ledger.ts` | the records, the freeze flag, the ledger |
| `src/tasks/` | discovery, the executable protocol, the TypeScript shim, the runner, validation |
| `src/smoke/` | the verdict, the helpers, the check runner, the stage |
| `src/settings.ts` | the schema, resolving, `-c` flags, SSM |
| `src/provenance.ts`, `src/github.ts` | GitHub deployments and the OpenTelemetry attributes |
| `src/status.ts` | status, run records, environments: what the MCP server will serve |
| `src/config.ts`, `src/wiring.ts`, `src/aws.ts` | `deploy.toml`, the real steps, the AWS CLI and SDK ports |
| `src/cli/` | the `deploy` binary |
| `src/cdk/` | the CDK target, rollback triggers, provenance context |

## Alternatives considered

- **Keep the pipeline in each project.** It works today, but a fix to the freeze path would land in one project and not the other, which is the drift ark exists to stop.
- **Run TypeScript tasks in the runner's process,** as longplay does. It is simpler, but the task then runs with the runner's credentials in reach, and two protocols have to be kept in step. The shim costs one Node start per step.
- **Rely on GitHub's `auto_inactive`.** It skips production environments, which is the one environment both projects deploy.
- **A CloudFormation-shaped target contract** (stack names, change sets). It would make the npm target fake a stack. Rollback triggers are the CDK target's business instead.
- **Settings as a TypeScript module.** It is more expressive, but `deploy.toml` keeps every tool's config in `<tool>.toml` as ark's other tools do, and a test in a project can read it without importing project code.

## Cross-cutting concerns

- **Security.** Each step runs with one role's keys in its child environment and no other. The runner's role reads the settings and the flag, sets the flag but never deletes it, writes the ledger but never deletes from it, publishes to one topic and assumes the work roles. Permissions are proven with IAM's policy simulator, with a refusal beside every grant, never with the emulator.
- **Failure of the tools themselves.** The freeze read fails closed; a notification, ledger write or GitHub call that fails is logged and the run goes on.
- **Testing.** longplay's tests move with the code, adapted to config. Property tests check that no sequence of step outcomes deploys while frozen, that every failure after the freeze is set leaves it set, that a task failure never rolls back and that a task in the ledger never runs twice. The ledger and the freeze flag run against the AWS Emulator, and provenance against a fake GitHub API.

## Open questions

- **Q1 (answered).** Does the extracted core keep longplay's run semantics behind a project-neutral config? **Yes.** Freeze before rollback, the fail-closed freeze read and no rollback for tasks are in the machine, not in names, and longplay's orchestrator tests pass against it unchanged in what they assert.
- **Q2 (answered).** Is the GitHub token a setting? **No.** It is a secret, so it lives in Secrets Manager and the project's runner role reads it; a project without one records no deployments and says so in the log.
- **Q3.** Several environments per project: one `deploy.toml` per environment, or environments inside one file with their own ledger keys? The records already carry the environment; the config has one. (For Niko, before a second environment exists.)

## Work

- acc99x0k: add the deployment member (this design)
- Next: move longplay onto the package; the read-only MCP server; the npm dist-tag target; draft's deployment kind; the release member

## Sources

- longplay at `main`: `infra/pipeline/`, `infra/lib/pipeline/`, `infra/lib/pipeline-stack.ts`, `infra/scripts/verify-platform.ts`, `infra/scripts/simulate-deploy-pipeline-policy.ts`, `docs/platform/runbooks/pipeline.md`
- [ark: Design Doc](00-ark-v1.md), [Agent setup: Design Doc](03-setup-v1.md)
- [CloudFormation rollback triggers](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-rollback-triggers.html), [cdk deploy](https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-deploy.html), [GitHub deployments](https://docs.github.com/en/rest/deployments/deployments), [deployment statuses](https://docs.github.com/en/rest/deployments/statuses), [OpenTelemetry VCS attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/vcs/), [deployment attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/deployment/)
