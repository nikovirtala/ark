# Freeze before rolling back, and never roll back a failed task

## Context
A failed deploy or smoke check has to leave the environment at a version that worked, and a person has to look before anything deploys again. longplay's run sets its freeze flag before it starts the rollback, because a build that dies during the rollback (a timeout, a lost role session) must still leave the pipeline frozen. Deployment tasks are different: they move data forward (seeding, migrations), and deploying an older commit does not undo them. Reading the flag can fail too, and a permissions mistake must stop deploys, not let them through.

## Decision
A run is a state machine: queued, preflight, deploying, smoking, running tasks, then succeeded, refused or frozen. A refusal before deploying (a missing REQUIRED setting, a failed preflight, a synth that fails) changes nothing and freezes nothing. A failed deploy or smoke check sets the freeze flag first, then deploys the last good commit with the same settings and no rollback triggers, then notifies, and ends frozen. A failed task sets the freeze flag and ends frozen with no rollback. The freeze flag is one SSM parameter: absent means not frozen; present, unreadable or holding anything but a freeze record means frozen. The machine has no transition out of frozen; only a person clears the flag, with deploy unfreeze.

## Scope
The run in packages/deployment (the state machine, the orchestrator and the freeze store) and every project's pipeline role, which may set the flag but never delete it.

## Consequences
- A half-done rollback still leaves the pipeline frozen.
- An unreadable flag stops deploys until a person looks.
- A failed task leaves the new commit deployed; the person fixes the task, unfreezes, and the task runs again on the next run.
- Property tests pin these rules: no sequence of step outcomes deploys while frozen, every failure after the freeze is set leaves it set, and a task failure never rolls back.
