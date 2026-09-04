HAMZAWE — Post-M4-F merge hardening bundle — 2026-09-04

BASELINE
main @ f01dba5732200085669a1d1bc120e58ff25a471d

PURPOSE
Apply the post-merge P1 recovery-evidence fix plus the bounded test/documentation reconciliation identified during supervisor verification.

CHANGED FILES
Application/PatientDisruptionService.js
  - Prevents DECLINE/TIMEOUT from clearing a pending disruption interaction when the replacement target is already CONFIRMED while the original reservation is still RESERVED. Returns M4F_RECOVERY_REQUIRED so Scheduler recovery retains durable evidence.

tests/HardeningM4F.test.js
  - Includes M4F-104/M4F-105 post-merge P1 regressions.
  - Explicitly allows the TD01 test-hygiene file in the M4-F authorized-change guard.

tests/HardeningTD01.test.js
  - Makes TD01-E4 preserve the same structural contract without depending on one exact whitespace layout of the legacy catch block.

PROJECT_CONTEXT.md
  - Reconciles current Scheduler stage order, M4-E/M4-F wiring, current M4-F merged status, and historical baseline wording.

PROJECT_CONSTITUTION.txt
  - Adds a dated current-status note after PR #24 merge while preserving the historical authorization record.

VERIFICATION PERFORMED
- HardeningTD01: 23/23 PASS.
- HardeningM4F: 103 functional tests PASS; 2 Git-dependent checks cannot run outside a .git checkout (M4F-51/M4F-54).
- Full local suite: all suites PASS except the known pre-existing HardeningM1B / M1B-X3 and the Git-dependent M4F checks above.
- node --check passed for all changed JavaScript files.

IMPORTANT
This bundle contains no production deployment, migration, trigger, or live-Sheet change. After applying it to the repository, review the resulting diff before committing/pushing.
