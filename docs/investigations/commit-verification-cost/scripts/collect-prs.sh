#!/usr/bin/env bash
# Collects closed pull requests, their commits, force-push events, workflow runs and jobs of
# nikovirtala/ark with the GitHub REST API (`gh api`; GraphQL is not available here).
# Writes JSON Lines to data/prs/. Keeps counts, numbers, shas, branch names and timestamps only:
# no logins, emails or names are stored. Resumable: files that exist are not fetched again
# (FORCE=1 refetches). Usage: collect-prs.sh [owner/repo]
set -euo pipefail
export MISE_QUIET=1
repo=${1:-nikovirtala/ark}
out="$(cd "$(dirname "$0")/../data/prs" && pwd)"
api() { gh api "$@" 2>/dev/null; }

if [ "${FORCE:-0}" = 1 ] || [ ! -s "$out/pulls.jsonl" ]; then
  : >"$out/pulls.jsonl.tmp"
  for page in 1 2 3 4 5 6; do
    api "repos/$repo/pulls?state=closed&per_page=100&page=$page" --jq '.[] | {number, created_at, closed_at, merged_at, draft, head_ref: .head.ref, head_sha: .head.sha, base_ref: .base.ref, base_sha: .base.sha, merge_commit_sha, base_is_main: (.base.ref == "main")}' >"$out/page.tmp"
    [ -s "$out/page.tmp" ] || break
    cat "$out/page.tmp" >>"$out/pulls.jsonl.tmp"
  done
  rm -f "$out/page.tmp"
  mv "$out/pulls.jsonl.tmp" "$out/pulls.jsonl"
fi

# One detail row per pull request: commit count, size, commit timestamps, force-push events.
if [ "${FORCE:-0}" = 1 ] || [ ! -s "$out/pull-details.jsonl" ]; then
  : >"$out/pull-details.jsonl.tmp"
  for n in $(jq -r .number "$out/pulls.jsonl"); do
    d=$(api "repos/$repo/pulls/$n" --jq '{number, commits, additions, deletions, changed_files}')
    c=$(api "repos/$repo/pulls/$n/commits?per_page=100" --paginate --jq '.[] | {sha, parents: (.parents|length), date: .commit.committer.date, subject: (.commit.message|split("\n")[0])}' | jq -s '.')
    e=$(api "repos/$repo/issues/$n/events?per_page=100" --paginate --jq '.[] | {event, created_at}' | jq -s '.')
    jq -cn --argjson d "$d" --argjson c "$c" --argjson e "$e" '$d + {commit_list: $c, events: $e}' >>"$out/pull-details.jsonl.tmp"
  done
  mv "$out/pull-details.jsonl.tmp" "$out/pull-details.jsonl"
fi

# Workflow runs (all events) and, for each CI run, its jobs.
if [ "${FORCE:-0}" = 1 ] || [ ! -s "$out/runs.jsonl" ]; then
  : >"$out/runs.jsonl.tmp"
  for page in $(seq 1 20); do
    api "repos/$repo/actions/runs?per_page=100&page=$page" --jq '.workflow_runs[] | {id, name, event, run_attempt, conclusion, head_sha, head_branch, created_at, run_started_at, updated_at, prs: [.pull_requests[].number]}' >"$out/page.tmp"
    [ -s "$out/page.tmp" ] || break
    cat "$out/page.tmp" >>"$out/runs.jsonl.tmp"
  done
  rm -f "$out/page.tmp"
  mv "$out/runs.jsonl.tmp" "$out/runs.jsonl"
fi

# Resumable: a run whose id is already in jobs.jsonl is skipped (FORCE=1 starts again).
[ "${FORCE:-0}" = 1 ] && rm -f "$out/jobs.jsonl"
touch "$out/jobs.jsonl"
for id in $(jq -r 'select(.name == "CI") | .id' "$out/runs.jsonl"); do
  grep -q "\"run_id\":$id," "$out/jobs.jsonl" && continue
  # A run without jobs leaves a marker row so that it is not asked for again.
  rows=$(api "repos/$repo/actions/runs/$id/jobs?per_page=100&filter=all" --jq ".jobs[] | {run_id: $id, name, conclusion, run_attempt, started_at, completed_at}")
  if [ -n "$rows" ]; then echo "$rows" >>"$out/jobs.jsonl"; else echo "{\"run_id\":$id,\"name\":null}" >>"$out/jobs.jsonl"; fi
  [ -n "${BUDGET_END:-}" ] && [ "$(date +%s)" -gt "$BUDGET_END" ] && { echo "budget reached, rerun to continue"; break; }
done
# Earlier attempts of rerun jobs: the runs API only lists the latest attempt of a run.
touch "$out/jobs-prior.jsonl"
for row in $(jq -r 'select(.name == "CI" and .run_attempt > 1) | "\(.id):\(.run_attempt)"' "$out/runs.jsonl"); do
  id=${row%%:*}
  last=${row##*:}
  for k in $(seq 1 $((last - 1))); do
    grep -q "\"attempt\":$k,.*\"run_id\":$id," "$out/jobs-prior.jsonl" && continue
    api "repos/$repo/actions/runs/$id/attempts/$k/jobs?per_page=100" --jq ".jobs[] | {run_id: $id, attempt: $k, name, conclusion, started_at, completed_at}" | jq -c . >>"$out/jobs-prior.jsonl"
  done
done
wc -l "$out"/*.jsonl
