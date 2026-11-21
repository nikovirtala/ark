# Let agents read deployments, and leave deploying to people

## Context
Agents work in these repositories with read-only AWS access. A deployment can delete data or take a service down, and the freeze flag exists so that a person looks before anything deploys again. A read-only MCP server for deployments comes next, and draft will offer unfreeze as a person's acceptance.

## Decision
The deploy CLI has status, settings, freeze, unfreeze, tasks, dry-run, run and forget. Only the pipeline runs a deploy, and only a person runs unfreeze, forget, settings or a task by hand. Any MCP server for deployments is read-only: status, run records, task listing and validation, simulation and smoke checks are library functions it serves, and none of its tools deploys, unfreezes or forgets. Each project's work roles trust its pipeline's runner role only, so an agent's role cannot assume them.

## Scope
The deploy CLI and any MCP server in packages/deployment, and the roles of every project's pipeline stack.

## Consequences
- An agent can see why a pipeline froze and propose the fix, but a person clears it.
- A project's AGENTS.md says that agents never deploy, and that a step only a person can do is marked needs-niko.
- draft's unfreeze goes through a person's acceptance, never an agent's call.
