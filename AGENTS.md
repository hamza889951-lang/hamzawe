# ClinicScheduler — AI Agent Instructions

## Primary Project Context

Before performing any non-trivial task in this repository, read:

`PROJECT_CONTEXT.md`

This file contains the project's persistent engineering context, architecture,
business rules, workflows, invariants, known technical debt, and current status.

IMPORTANT:
- PROJECT_CONTEXT.md is project context, NOT the ultimate source of truth.
- The actual repository code is always the final source of truth.
- Use PROJECT_CONTEXT.md to understand the architecture and identify the files
  relevant to the requested task.
- Do NOT scan the entire repository when the task can be completed by inspecting
  a focused subset of files.

## Efficient Context Usage

Follow this sequence:

1. Read PROJECT_CONTEXT.md.
2. Identify the smallest set of files relevant to the task.
3. Inspect those files and their necessary dependencies.
4. Analyze the requested change.
5. Propose the smallest safe change.
6. Implement only after approval when the task requires approval.
7. Verify the implementation against the actual code and project rules.

Do NOT repeatedly re-read unrelated files.

Do NOT perform a full repository analysis unless the task genuinely requires it.

## Architecture

This is a hardening project, not a rewrite.

Preserve the existing Clean Architecture structure and contracts.

Do not casually:
- refactor unrelated code
- move files
- rename globals
- delete legacy/compatibility code
- change schemas
- change state names
- change APIs
- add triggers
- redesign workflows

## Critical Invariants

Treat these as protected unless the task explicitly requires changing them
and the impact has been analyzed:

- Config.VOCABULARY
- StateMachine.transitions
- Result contract
- LogRepository append-only contract
- SlotRepository.atomicUpdate semantics
- is_available meaning
- Clock.now() time-source rule
- the single daily Scheduler trigger
- existing sheet column contracts

## Concurrency

Assume Webhook and Scheduler can execute concurrently.

For every booking/state-changing operation, consider:

- ScriptLock scope
- fresh re-read before mutation
- transition validation
- ownership validation
- lock timeout
- retry/idempotency behavior
- partial failure

Never bypass SlotRepository.atomicUpdate for a state-changing slot mutation.

## Result Contract

Functions must follow the project's Result contract.

Use:

Result.ok(data)

or:

Result.fail(code, message, details)

Do NOT use:

Result.ok({success:false})

to represent a failure.

## Scope Discipline

Only modify files necessary for the requested task.

If an improvement is unrelated to the requested task, do not implement it.
Report it separately as:

OPTIONAL FUTURE IMPROVEMENT

## Verification

Before claiming a task is complete:

- inspect the actual changed code
- verify affected callers/dependencies
- verify relevant state transitions
- verify concurrency implications
- verify error handling
- verify timezone/date handling when relevant
- verify no protected contract was accidentally changed

Never claim that changes were pushed, deployed, or live-tested.

The owner handles:
- git commit/push
- Apps Script deployment
- trigger configuration
- live testing

## Communication

For review/analysis tasks, do not modify code unless explicitly requested.

Use the owner's preferred reporting structure:

STATUS
What I inspected
Findings
Risk
Recommendation
Changes
Verification

Use P0-P4 severity when reporting risks.
