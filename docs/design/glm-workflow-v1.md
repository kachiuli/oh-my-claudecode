# Claude / GLM / Codex V1 implementation design

## Upstream audit

Fetched upstream/main directly from https://github.com/Yeachan-Heo/oh-my-claudecode
on 2026-09-12. Exact upstream and initial fork HEAD:
`5281b19e0d64f8e6dc6767f2130299a88af2dc71` (package version 5.4.0).
Implementation branch: `codex/glm-workflow-v1`.

The active provider contracts are `src/team/model-contract.ts` (`CliAgentType`)
and `src/shared/types.ts` (`TeamRoleProvider`). `stage-router.ts` resolves existing
`team.roleRouting`; `config/loader.ts` validates it. Provider probing lives in
`team/cli-detection.ts` and `cli/commands/doctor-team-routing.ts`. Ask has its own
parser and `scripts/run-provider-advisor.js` execution surface. Legacy bridge
and deprecated external-model routing types must be distinguished from active
team providers instead of blindly widening every union.

`team/runtime-v2.ts` owns pane startup, dispatch, recovery, canonical team state,
and prompt-mode external workers. Codex/Cursor deliberately use persistent panes;
GLM must use the existing prompt-mode seam. `team/git-worktree.ts` already provides
named worktrees, base refs, mapping validation, and dirty-preserving cleanup.
`team/merge-orchestrator.ts` continuously merges worker commits: that mechanism
cannot express explicit lead acceptance and will remain disabled for this profile.
`team/cli-worker-contract.ts` provides structured review artifacts;
`shared/artifact-descriptor.ts` provides bounded artifact handoff conventions.
Existing verification executes shell command strings, so workflow verification
will accept executable/argument arrays and preserve the local-before-review gate.

## Implementation and cleanup plan (before source changes)

1. Extend current provider contracts, detection, ask, team parsing and role routing
   with GLM. Configure only a local executable and optional model, never auth.
   Missing GLM fails closed; retain all existing provider defaults.
2. Expand an opt-in `claude-glm-codex` profile into existing `team.roleRouting`.
   Keep the lead Claude; planner/architect use HIGH, bulk execution GLM, reviews Codex.
3. Add a focused team workflow controller and reachable `omc team workflow`
   commands. Reuse native worktrees, provider command construction, canonical OMC
   state roots, atomic writes and artifact descriptors. Do not replace runtime-v2.
4. Require a structured lead-authored plan before worker dispatch. Validate paths,
   dependencies and ownership; bound concurrency (default 4, maximum 6), attempts
   and output. Reject unsafe scope overlap rather than launching conflicting work.
5. Require committed, scoped worker results. Explicit lead acceptance integrates
   commits on a non-main branch; rejection never integrates. Preserve failed or
   dirty worktrees and keep transcripts in artifacts outside normal handoffs.
6. Bind verification and independent Codex read-only review to the integrated HEAD.
   Persist structured findings and lead dispositions. Permit GLM remediation, with
   at most two review passes by default; unresolved blockers cannot report success.
7. Add credential-free fake-process and real temporary Git repository tests,
   including three workers, integration, P1/P3 adjudication, fix and re-review.
8. Run lint, typecheck, build and regression tests; independently review the diff.
   Document exact failures and baseline differences. No new dependencies, broad
   refactors, generated shipping artifacts, automatic push, or history rewriting.

## Deliberate V1 limits

One process per assignment, per-workflow concurrency only, no persistent sessions,
no cache affinity, no distributed scheduling, no CI subsystem or new providers
beyond GLM. Claude decisions are explicit controller operations: a provider's
claim of success or review verdict never authorizes integration by itself.
