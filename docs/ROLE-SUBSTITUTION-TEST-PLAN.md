# Role substitution: implementation acceptance plan

Status: proposed checks, **not executed**, 2026-09-15. Read the
[design](ROLE-SUBSTITUTION-DESIGN.md) for scope, authority, dependency and legacy
compatibility. This plan does not authorize provider calls or alter a saved run.

## Test interface and fixtures

Exercise the same public workflow functions/CLI used by callers. Extend the
existing real child-process fixtures and temporary Git repositories; do not prove
behavior solely by asserting a private argv-building helper's return value.
Keep the existing full workflow tests. New tests should demonstrate a
discriminating failure before the corresponding implementation.

Use synthetic source and unique task/worktree/artifact paths. A substitute process
reports its received safe role/model/argument metadata, writes the exact permitted
commit or produces a structured finding, and can deliberately fail, hang or emit
an invalid protocol. Never put real auth values in fixture output. Preserve first
failures, partial source and artifacts according to the workflow contract.

The newly introduced adapter must be injected at the invocation seam. Existing
controller validation, actual subprocess outcomes and Git artifacts remain real.
Where a fixture cannot establish real CLI behavior, mark that result synthetic
and use the separate live checks below.

## Required synthetic observations

| ID | Public scenario | Required observable result |
| --- | --- | --- |
| R01 | Initialize/read legacy V1 and balanced V1.1 fixtures with old options. | Old schema/profile/default routes remain valid; read-only inspection does not rewrite bytes; unknown version/profile rejects before dispatch. |
| R02 | New-profile route matrix: GLM worker, Claude worker, Codex reviewer, Claude reviewer. | Actual child argv/cwd/model and saved binding match the selected operation; no generic interactive Codex flags leak into review. |
| R03 | New profile supplies an unsupported model/effort or missing required operation capability. | Visible prelaunch failure; no model downgrade and no alternative provider call. |
| R04 | GLM unavailable; record a Claude worker substitution and execute one task. | First failure and substitution are retained, one permitted owned commit passes controller replay, and acceptance still requires the explicit operation. |
| R05 | Codex provider attempt fails for availability; record Claude review at the verified head. | Real structured findings reach the normal parser/adjudication path; the next review pass is charged and the old failed attempt remains. |
| R06 | Same author/agent reviews with known self-review relation; separate reviewer and unknown relation controls. | All may complete if other checks pass; reports label self-review/independent/unknown accurately. No failure solely for matching identities; acceptance alone does not mark the lead as author. |
| R07 | External Astra lead follows successful task completion. | Existing guarded accept/verify/adjudicate/finish operations remain available; worker-marked caller stays rejected; lead handover/provenance records actual safe metadata. No Codex implementation adapter is required. |
| R08 | Seed conflicting synthetic GLM routing variables and choose normal Claude, then the reverse control. | Spawned child sees only its intended auth-route identity; normal profile and GLM wrapper remain distinct; no values leak into artifacts. Test the actual environment seen by the child. |
| R09 | Enable the existing external-model-disable control. | Normal Claude remains eligible while GLM/Codex are blocked, matching the existing model-contract policy; a false Claude label cannot bypass auth-route validation. |
| R10 | Provider exits zero with malformed/absent handoff, unsupported review path or failed test evidence. | Invocation fails visibly; no automatic substitution and no empty successful review; raw bounded artifacts and review/task counters survive. |
| R11 | Exhausted task attempts or review passes, including a failed replacement invocation and missing-executable preflight control. | Next launch rejects without resetting/increasing budgets; substitution history cannot erase reserved attempts. Preflight/selection-only metadata preserves the diagnostic without inventing a provider call or reservation. |
| R12 | Concurrent substitution while a controller owns the lock or a worker is running. | Binding cannot change underneath that invocation; first operation/artifacts remain intact; no stale-lock cleanup or automatic respawn. |
| R13 | Confirmed same-binding balanced resume, plus changed provider/model/auth/executable/task/base/context controls. | Compatible resume retains identity; each incompatible case refuses reuse and preserves source/artifacts. Cross-provider UUID reuse is never continuation. |
| R14 | Timeout/interruption after no edit, partial edit and commit respectively. | Owned process termination and terminal evidence are accurate; changed work is retained, no unbounded retry, old results/logs are not overwritten. |
| R15 | Normal Claude stream has complete, partial, absent and conflicting usage/terminal data. | Actual provider attribution and measured/partial/unknown coverage are truthful; tokens are not billing/savings evidence; protocol failure cannot be masked by usage. |
| R16 | Reviewer attempts a source write, ref change or command tool through the selected route. | Invocation/tool restriction prevents unsupported actions where claimed; controller source/ref guards detect changes. Successful final equality alone is not evidence transient writes were prevented. |
| R17 | Adopted review-path controls: relative/null findings, Windows/POSIX/UNC/traversal/reserved paths and the preserved six-finding shape. | Corrected shared contract applies to both reviewers; invalid results fail with retained evidence rather than stripped or empty findings. |
| R18 | New route reports correct work but commit parent, write scope, dependencies or exact checks are wrong. | Existing ownership/handoff/controller replay checks still reject; route change is not a bypass. |
| R19 | Usage/status includes mixed historical/new routes and failures before telemetry. | Each invocation is attributed to its saved binding; absent usage remains unknown; task/review totals do not invent provider totals. |
| R20 | Same-session self-review, only if supported in phase one. | Actual role permissions/context are re-established and authoring context is reported. If unsupported, the fresh self-review path still works and this capability stays explicitly unavailable. |

## Existing suites and future command set

The current baseline has these workflow suites:

```text
src/team/__tests__/workflow.test.ts
src/team/__tests__/workflow-balanced.test.ts
src/team/__tests__/workflow-contracts.test.ts
src/team/__tests__/workflow-process.test.ts
src/team/__tests__/workflow-routing.test.ts
src/team/__tests__/workflow-usage.test.ts
src/team/__tests__/workflow-report.test.ts
```

After scoped implementation and dependency adoption, run the repository's
`npm run build`, targeted `npm run test:run -- <the suites above and actual new
test paths>`, `npm run lint`, and appropriate configuration/process regression
suites affected by the change. Build includes TypeScript and generated runtime
outputs. Record exact executed argument arrays, source/head, exits, counts and
skips; the placeholder list is not a runnable command or a promised test count.
Follow with required repository-wide checks if failures, changed public surfaces
or the implementation's assigned acceptance gate require them. Do not equate
targeted green tests with an unexecuted complete repository suite.

On native Windows use directly executable Node/provider paths with argument
arrays, preserving the existing no-shell launch rule. Do not make a provider's
`.cmd`/PowerShell wrapper an exception. Dependency installation, if needed later,
uses the existing locked dependency set; this documentation adds none.

## Separate bounded live compatibility checks

These require the selected authenticated routes to be available. No such call was
made for this packet. Run them under the authorized implementation/adoption task,
on synthetic source, with explicit invocation and review limits; do not induce a
real outage, exhaust quota or change global profiles.

| ID | Live check | Evidence required |
| --- | --- | --- |
| L01 | Actual normal Claude implements a tiny owned change through the new adapter. | Correct route/model/session identity; one owned commit; exact handoff and actual controller replay; normal/GLM profile guards unchanged. |
| L02 | Actual normal Claude reviews a synthetic committed defect using the proposed restricted tool set and schema. | Exact version/argv, effective tools, terminal/structured-output shape, meaningful correctly located finding, controller acceptance and no repository/ref changes. A valid zero-finding control is separate. |
| L03 | Read-only restriction challenge on throwaway source. | Observed denial of requested source writes/command execution and unchanged tracked/untracked fixture state; a clear limit if runtime permissions cannot provide the claimed restriction. Do not rely on a cooperative prompt. |
| L04 | Explicit recorded substitution after locally simulated unavailable command, without contacting it. | One actual replacement launch under existing budget and retained synthetic availability failure; no hidden model/provider fallback. |
| L05 | Authenticated external Astra lead records a bounded plan/disposition and invokes guarded operations on the synthetic workflow. | Actual caller/model evidence when available, meaningful decision, source guards and truthful lead attribution. This validates an existing external-lead path; it is not proof of a Codex implementation adapter. |

Capture only safe operation/status/model identity, known usage, output-schema
fields and hashes needed to bind evidence. No credentials, full private
transcripts or copied profile contents enter a repository. Preserve earlier
failures. Partial or absent live evidence stays explicitly pending; local help
and synthetic providers cannot stand in for these observations.

## Handoff and adoption packet

Return the implementation commit and parent/dependency commits, changed paths,
new built CLI and compiled-contract hashes, precise synthetic/live results,
source/profile integrity observations, review relation, remaining limitations and
versioned-state compatibility result. Include a test proving an old saved run is
readable without migration. Identify the selected future runner pin explicitly.

Old evidence remains bound to its original source/runtime. Do not relaunch an old
failed review to manufacture a new result, reset a budget or adopt a binary merely
because this test plan exists. The lead's adoption decision and project-specific
acceptance gates remain separate from implementation checks.
