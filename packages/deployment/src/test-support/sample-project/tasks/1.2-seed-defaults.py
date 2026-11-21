"""A sample deployment task in Python, shaped like longplay's release tasks: it answers --needs,
--dry-run and --run, reads the commit and its outputs from LP_RELEASE_COMMIT and LP_RELEASE_OUTPUTS
(longplay's names) or DEPLOY_TASK_COMMIT and DEPLOY_TASK_OUTPUTS, and prints a last line
{"summary": "..."}."""

import json
import os
import sys

NEEDS = {
    "role": "sample-deployment-task-seed",
    "description": "Seeds the defaults a new environment needs (a sample).",
    "outputs": ["TableName"],
}


def main(argv):
    if argv == ["--needs"]:
        print(json.dumps(NEEDS))
        return 0
    if argv not in (["--dry-run"], ["--run"]):
        print("usage: 1.2-seed-defaults.py --needs | --dry-run | --run", file=sys.stderr)
        return 2
    commit = os.environ.get("LP_RELEASE_COMMIT") or os.environ.get("DEPLOY_TASK_COMMIT", "")
    outputs = json.loads(os.environ.get("LP_RELEASE_OUTPUTS") or os.environ.get("DEPLOY_TASK_OUTPUTS") or "{}")
    table = outputs.get("TableName", "(no table)")
    print(f"seeding {table}")
    verb = "would seed" if argv == ["--dry-run"] else "seeded"
    print(json.dumps({"summary": f"{verb} 3 defaults into {table} for {commit[:7]}"}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
