# GLM workflow V1 implementation and validation report

Date: 2026-09-12. Environment: Windows, Node 24.18.1, Git, Vitest 4.1.11.

## Source and delivery

- Fetched current upstream/main before source changes:
  `5281b19e0d64f8e6dc6767f2130299a88af2dc71`.
- Initial fork HEAD was identical; upstream package version was 5.4.0.
- Dedicated branch: `codex/glm-workflow-v1`.
- No dependencies added or upstream history rewritten. Publication targets the
  personal fork; no pushes to the upstream repository.
- Generated distribution and bridge outputs are build products, not part of the
  source change. Run `npm run build` before using the updated checkout CLI.

## Architecture and behavior

The implementation extends current CLI provider contracts, existing `roleRouting`,
native named worktrees, canonical team paths, atomic IO and artifact descriptors.
It does not replace OMC or introduce another worktree manager. The design note was
written before implementation: [upstream audit and plan](design/glm-workflow-v1.md).

GLM is selected with `omc ask glm` and `omc team N:glm`, with a local `claude-glm`
executable or configured absolute executable path. Prompts and model arguments
are passed without shell interpolation. Native GLM launches require runtime-v2,
use named worktrees, and refuse automatic merging. Existing providers retain their
default behavior. Legacy `detectAllClis()` retains its original zero-argument keys;
GLM detection is opt-in, and doctor probes configured GLM directly.

The profile maps planner/architect to Claude HIGH, executor/debugger/test-engineer
to GLM, and critic/code-reviewer to Codex. The lead stays Claude. Configuration:
`team.profile`, `team.glm.command`, `team.glm.fallback`,
`team.glm.defaultWorkers`, `team.glm.maxWorkers`, and
`externalModels.defaults.glmModel`. Default concurrency is four workers with a
configured ceiling of six; the existing OMC absolute ceiling remains twenty.
These are local OMC limits, not provider subscription guarantees.
The strict controller also resolves executor/reviewer models through existing
role routing and rejects incompatible provider overrides instead of ignoring them.

The strict pipeline is reachable through `omc team workflow`: init, run, status,
accept, reject, verify, review, adjudicate, add-fix, finish, cleanup. The Claude
lead supplies the structured plan and makes acceptance/disposition decisions.
Neither workers nor review verdicts implicitly authorize integration.

Assignments require a base commit, explicit scopes, dependencies, contracts,
acceptance criteria and test commands. Independent tasks run concurrently;
dependent tasks wait for acceptance and inherit the integrated base. Overlapping
ownership without dependency ordering is rejected. Admission queues excess tasks;
attempts/backoff are bounded and observable throttling is classified.

Workers receive separate native worktrees and must return exactly one coherent
commit. The controller checks branch registration, commit parent, clean status,
actual changed paths, ownership and handoff identity. It independently executes
declared scoped tests. Accepted commits are cherry-picked onto the dedicated
integration branch. Rejected work never integrates. Non-worker refs are checked
for unexpected mutation. Dirty, failed and interrupted work is preserved.

Worker output uses bounded result metadata and artifact references. Logs are
capped and redacted; normal status is capped at 16 KiB, with explicit omitted
counts and references to complete state/results. Output includes task/provider,
model, status, attempts/backoff, branch/worktree, activity, integration and review
state, and concise tests/API changes/assumptions/risks.

Verification executes argument-array commands locally and is bound to the exact
integration commit. Codex review is gated on successful current verification,
uses `exec --sandbox read-only`, an output schema and an external result file,
and receives acceptance criteria/contracts rather than GLM transcripts. It
checks code independently. Repository/ref changes during review are rejected.
The lead explicitly adjudicates findings, supplies scoped remediation tasks, and
accepts resulting fixes. Default review budget is two passes. Exhaustion or
unresolved accepted findings never becomes automatic success.

## Validation evidence

The credential-free fixtures use actual local Node child processes and temporary
Git repositories. The mandatory scenario covers three independent GLM tasks,
commits, explicit integration, local checks, P1/P3 findings, lead fix/dismiss
decisions, a GLM correction, one final review, completion and cleanup. Assertions
cover transcript exclusion, branch/worktree isolation, unchanged main, review
limit, clean worktree removal and dirty worktree preservation.

Final source checks passed:

| Check | Result |
| --- | --- |
| GLM provider suite | 23 passed |
| Workflow controller, including deterministic end-to-end scenario | 21 passed |
| Workflow contracts | 12 passed |
| Child processes, bounded output and artifact protection | 15 passed |
| Workflow role/model routing | 4 passed |
| Workflow CLI | 14 passed |
| Existing artifact descriptor suite | 3 passed |
| **Final targeted total (seven files)** | **92 passed, zero failed or skipped** |
| Selected GLM extensions in existing ask/preflight/scaling/acknowledgement/doctor suites | 17 passed; 179 unrelated tests filtered out |
| `npm run build` (including TypeScript compilation and CLI/runtime bundles) | Passed |
| `npm run lint` | Passed |
| `tsc --noEmit` | Passed |
| Built `node bridge/cli.cjs team workflow --help` | Passed |
| `git diff --cached --check` | Passed |

The final targeted test command was:

```text
npx vitest run src/team/__tests__/glm-provider.test.ts src/team/__tests__/workflow.test.ts src/team/__tests__/workflow-contracts.test.ts src/team/__tests__/workflow-process.test.ts src/team/__tests__/workflow-routing.test.ts src/cli/commands/__tests__/team-workflow.test.ts src/__tests__/artifact-descriptor.test.ts --maxWorkers=3 --reporter=json --outputFile=C:/Users/kachi/AppData/Local/Temp/omc-glm-final-tests.json
```

An additional compatibility selection across eight existing routing, snapshot,
worker-contract, acknowledgement and doctor files produced 126 passed, 20 failed
and 35 skipped tests. All 20 failures were in worker launch acknowledgement;
the exact-upstream comparison below reproduced each one.

Machine-readable results and command logs are retained locally under
`.omc/reports/glm-v1/` (ignored execution evidence, not committed source).

### Upstream comparisons and broad-suite limitation

An isolated checkout of the exact upstream SHA was used for comparisons:

| Suites | Exact upstream | Feature branch | Comparison |
| --- | --- | --- | --- |
| Config loader, model contract, native worktrees | 162 passed, 30 failed, 192 total | 162 passed, 30 failed, 192 total | Identical failing test names; no new failures |
| Worker launch acknowledgement | 25 passed, 20 failed, 35 skipped | 26 passed, 20 failed, 35 skipped | Same 20 failures; added GLM identity test passes |

A broad `npm run test:run -- --maxWorkers=4` run, started before implementation
and continuing while files were being edited, finished with 12,891 passed,
1,028 failed and 75 skipped tests (13,994 total), plus four unhandled errors.
742 files: 595 passed, 144 failed, three skipped. Duration: 1,057.66 seconds.
It is evidence of a non-green environment, not a final-snapshot release result.

Observed failures include Windows absolute-path ESM imports, unsupported
directory-FD containment on Windows, POSIX process/path assumptions, missing
Python, and fixture file-lock/cleanup failures. Three unhandled errors were
Windows ESM URL failures; the fourth was unsupported directory-FD traversal.
Only the explicitly compared failures above are established as upstream-identical.
The entire broad failure set has not been classified or repaired.

**The requirement that all existing tests pass is not met on this host. Full
backward compatibility and production readiness are not claimed.** A full clean
run in the upstream-supported environment remains a release gate.

## Changed modules and simplifications

- Provider configuration/routing: `src/team/glm-config.ts`,
  `src/team/model-contract.ts`, `src/shared/types.ts`, `src/config/loader.ts`,
  `src/team/stage-router.ts`.
- Provider entry points: ask CLI/advisor, team CLI parsers, doctor and CLI detection.
- Native runtime compatibility: runtime-v2, legacy-v1 rejection, scaling,
  launch acknowledgement/bootstrap, capability/readiness tables and persisted
  provider/state validation. Hook/provider exclusion lists accept GLM.
- Workflow: `src/team/workflow.ts`, `workflow-contracts.ts`, `workflow-process.ts`,
  and `src/cli/commands/team-workflow.ts`.
- Shared artifact writer: optional exclusive creation prevents existing artifact
  files from being overwritten; default behavior remains unchanged.
- Tests: GLM provider tests, four workflow suites, real fake-provider fixtures,
  CLI workflow tests, plus regressions in existing advisor, doctor, preflight,
  scaling, detection and launch acknowledgement suites.
- Documentation: README entry, architecture/API cross-links, setup/workflow guide,
  pre-implementation design audit, this report and the V2 roadmap.

Existing helpers replace potential duplicate systems: native worktrees provide
creation/mapping/cleanup, existing role routing resolves the profile, and artifact
descriptors carry detailed output. No persistent-session pool, distributed
scheduler, CI subsystem or speculative provider load balancer was added.

Independent review identified and corrected worker-authority marker handling,
pool-lock lifetime, interrupted-queue behavior and review schema locations.
Tests additionally found lock-path misuse, missing dependent-task base updates,
trust in worker test claims, ref mutation and capture-boundary redaction cases.

## Deliberate limitations and upstream adaptations

- `fallback: false` is supported and required; `true` is rejected instead of
  implementing quota-consuming fallback in V1.
- The ordinary team runtime is pane-oriented; strict workflow control is a
  separate opt-in command beside runtime-v2, reusing native infrastructure.
- Existing auto-merge cannot express lead acceptance and is disabled for GLM.
- Existing general Codex ask execution bypasses sandboxing, so independent review
  uses a dedicated read-only CLI invocation through existing executable resolution.
- Existing verification uses shell command strings; the strict workflow uses
  safe argument arrays and local evidence instead.
- Worktrees are Git isolation, not an OS sandbox. The local provider executable
  remains trusted; scope/ref checks detect unauthorized results before acceptance.
- Interrupted/timed-out assignments retain work and require inspection before
  a new scoped workflow. There is no persistent-session reconnect/reuse.
- Native pane behavior needs tmux/psmux; the explicit workflow uses local child
  processes. Paid-provider authentication and a real GLM endpoint were not tested.
- On Windows, use directly executable wrappers/commands. Shell shim expansion is
  intentionally unsupported on the GLM/strict-verification path.
- Scoped tasks use literal paths/prefixes, not arbitrary globs, and one commit per
  assignment. Logs and status intentionally truncate with artifact references.
- The lead chooses relevant verification commands. The controller checks their
  execution; it cannot prove that chosen checks cover every acceptance criterion.

CI guidance is documentation only: local checks first, coherent integration pushes,
concurrency/cancellation groups and path filters, optional self-hosted routine
runners and clean hosted final verification. No worker auto-push or runner management.

V2 extension points—provider lifecycle, scope-aware admission, context artifacts,
pod transport, global leases and richer verification/CI evidence—are described in
[the short roadmap](GLM-WORKFLOW-V2.md). None of those V2 capabilities is implemented.
