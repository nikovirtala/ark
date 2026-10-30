# Run CI's test jobs on the arm runner with 6 workers

## Goal
Move the per-package test jobs in `.github/workflows/ci.yml` to GitHub's `ubuntu-24.04-arm` runner and run vitest with 6 workers, so the issues job, the slowest, finishes sooner.

## Notes
Measured in the throwaway PR #56 (closed): every package with 3, 4 and 6 workers on `ubuntu-latest` (x86) and `ubuntu-24.04-arm`, both 4 cores. Averages over 3 x86 rounds and 2 arm rounds:
- issues: x86 331s at 3 workers (today), 363s at 4, 331s at 6; arm 323s, 300s, 262s.
- adr: x86 230s, 200s, 176s; arm 193s (one run), 149s, 135s.
- ledger: 23-40s everywhere.
- CPU was 82% busy at 3 workers on x86 and 96-98% at 6. issues on x86 ranged 272-399s with the same settings, so the averages are rough.
- Arm runners are free for public repositories.
- One arm run failed on an ordering bug in `list --since`, fixed in #58; land that first.

## Done when
- The test jobs run on `ubuntu-24.04-arm` with 6 vitest workers, and the required `check` works as before.
- Two CI runs on the PR pass, with their test job times in the closing reason next to the x86 numbers above.
- The PR closes this issue in the same change, with a reason saying how each condition was met.
