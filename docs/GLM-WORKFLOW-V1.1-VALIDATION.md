# Local workflow V1.1 validation

Date: 2026-09-12. Environment: Windows, Node 24.18.1, Git, Vitest 4.1.11.

## Scope and delivery

V1.1 builds on V1 commit `3e51fcf70545c2bc3ee5a24a9f11844e8a294c57` on
`codex/glm-workflow-v1.1`. The V1 branch remains unchanged. The upstream package
version stays 5.4.0; this is a personal workflow revision, not an npm release.
The [implementation plan](design/glm-workflow-v1.1.md) preceded code changes.

Balanced mode adds stable shared context before full task contracts, accepted
dependency previews with artifact references, structured per-invocation usage,
a coverage-aware usage report and explicit continuation of a failed task in its
original pristine worktree. Existing saved workflows and omitted mode remain V1.

No dependencies, additional providers, distributed scheduler or alternate
worktree manager were added. The prompt builder reuses one copy of the existing
worker instructions, adding quality/context guidance only in balanced mode.
The process runner, workflow lock, artifact validation, worktree management,
acceptance, deterministic checks and read-only review remain the existing paths.

## Evidence

Verification uses local Node provider fixtures and real temporary Git repositories.
No authenticated Claude, GLM or Codex request was made. CLI event/flag contracts
were checked against official documentation and local Claude Code 2.1.258 and
Codex CLI 0.153.4 help output.

- The consolidated workflow, balanced-mode, provider, CLI, artifact, scaling and
  preflight suite passed **251 tests across 12 files**, zero failures or skips
  (168.79 seconds). The final Codex transient-error correction was then verified
  by **63 passing usage/process tests**, including five additional cases.
  Across these runs, all **256 distinct targeted cases** passed. An earlier
  215-test regression run and shared-context boundary checks also passed.
- Balanced integration covers distinct task sessions/worktrees, stable prefixes
  and complete contracts, accepted dependency handoffs, partial/missing usage,
  failed review accounting, explicit same-task continuation, unchanged V1 gates,
  and rejection of changed model/context/command/environment/branch/base,
  dirty work, missing session confirmation, exhausted budgets and worker callers.
  All 24 balanced integration cases passed in the consolidated run.
- Usage/process tests cover all-model versus main-loop scope, cache normalization,
  missing and malformed counters, duplicate/conflicting terminal events, failure
  accounting, bounded UTF-8 stream parsing beyond captured log limits, credential
  redaction and opt-in structured success/failure detection.
  The final 63 usage/process tests passed in both the implementation and
  independent review lanes.
- Build, lint, TypeScript checking and the built workflow help smoke check passed.

## Independent review corrections

Separate review passes cover code outside each reviewer's authored production
files. Controller review found two recovery defects, corrected before delivery:

1. A later ordinary run could start a fresh session after an explicit resume had
   failed. Failed resumed tasks now require another explicit continuation.
2. Resume could bypass the retained-running-task guard used by ordinary run.
   Both operations now require inspection of interrupted running work first.

Regression tests cover both corrections. Integration tests also caught missing
failed-review records during implementation; failed review attempts now remain
in the ledger and usage totals while still consuming the review-pass budget.

The independent process/accounting pass additionally found an omitted optional
Codex cache-write counter, a path by which a UUID-shaped credential echoed as
a session ID could enter telemetry, and false failure after Codex recovered from
a temporary connection error. All three are addressed with focused regressions.
Session metadata now uses the same credential boundary as captured output,
including case-normalized UUIDs. A later successful Codex completion can supersede
an earlier provisional error; definitive failed turns and errors after completion
remain failures. Both independent review lanes reported no remaining findings
in their respective scopes after rechecking the corrections.

## Practical limits

These checks establish local controller behavior, not measured cost savings or
end-to-end authenticated readiness. A user-run provider smoke test is still
required. Z.AI may omit cache fields; unknown usage must not be treated as free
work. CLI counters are observations, not subscription billing or dollar prices.

Resume requires a saved explicit GLM model, the same verified task/worktree and
remaining budget. Dirty or committed failures remain preserved for inspection.
The controller fingerprints relevant launch environment and executable identity,
but cannot discover every configuration source used inside a custom wrapper.
Keep its profile, authentication route and session files unchanged.

New tasks always start separate conversations in separate worktrees. Cross-task
conversation forks, scheduling by cache affinity, dynamic system-prompt CLI
tuning and distributed/CI coordination are deferred. Provider-generated system
context and worktree paths still affect caching.

The broader Windows suite was not rerun for this focused revision. The existing
[V1 report](GLM-WORKFLOW-VALIDATION.md) records its failures
and upstream comparisons. A clean full suite in a supported environment and live
provider validation remain release gates; V1.1 does not claim full release readiness.

Changed areas: `src/team/workflow.ts`, `workflow-contracts.ts`, `workflow-prompt.ts`,
`workflow-process.ts`, `workflow-usage.ts`, `workflow-report.ts`, the workflow CLI,
their tests/fixtures, README, handoff prompt, detailed guide and roadmap.
