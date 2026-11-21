# Run deployment tasks as executables that answer three flags

## Context
Deployment tasks are one-off steps after a deploy (seeding a table, a first run, a scratch check). longplay has them in TypeScript, imported into the runner's process, and in Python, run as a script that answers --needs, --dry-run and --run. kiro-remote and later projects may write them in other languages. A task in the runner's process can reach the runner's credentials, and two contracts have to be kept in step.

## Decision
A deployment task is any executable in the project's tasks directory, named <n>[.<m>]-<slug>, run in numeric order. --needs prints one JSON line with its role, description and the stack outputs it reads; --dry-run and --run change nothing and do the work, and print a last line {"summary": "..."}; a non-zero exit is a failure. It gets its declared role's keys, the commit and its outputs in its environment and nothing else. A file extension may map to an interpreter. A TypeScript module that exports needs, dryRun and run is wrapped by the package's shim into the same protocol, in its own process. The runner dry-runs and runs each task not in the ledger, records both, and stops at the first failure. A task in the ledger never runs again: its DONE item is written with a condition.

## Scope
The task runner, the protocol and the TypeScript shim in packages/deployment, and every project's tasks directory.

## Consequences
- A task can be written in any language, and every task sees only its own role's keys.
- A TypeScript task costs one Node start per step.
- A summary is one line of ids, counts and names; what a task prints stays in the build's log.
- deploy tasks --check (and later deploy_validate_task) can check a task from its --needs alone.
