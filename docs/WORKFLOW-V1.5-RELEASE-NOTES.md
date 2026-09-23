# Workflow V1.5 release notes

`workflow-v1.5` is the first fork release after merging upstream oh-my-claudecode 5.5.0 into the fork's `main`. It keeps the V1.4 repository hosts and workflow controller, adds the maintenance fixes validated by the live Claude lead run, and records a live lead/worker/reviewer matrix across Claude Code, Codex and GLM. The package version follows upstream and is 5.5.0; `workflow-v1.5` is the workflow release label.

## Install this custom release

Use the archive attached to the `workflow-v1.5` GitHub release:

```sh
npm install -g https://github.com/kachiuli/oh-my-claudecode/releases/download/workflow-v1.5/oh-my-claude-sisyphus-workflow-v1.5.tgz
omc setup --host both --scope project
omc orchestrator use claude
omc launch
```

The archive keeps package version 5.5.0 and records the tagged source commit in `gitHead`. Its accompanying release evidence records the SHA-256 checksum and file manifest. This custom release does not replace the upstream npm registry package. Existing `workflow-v1.4.x` project setups need no migration; rerun `omc setup --host both --scope project` after upgrading so the projected guidance picks up the new recovery instructions.

## workflow-v1.5.1 maintenance

`workflow-v1.5.1` ships the same runtime as `workflow-v1.5` plus one CI maintenance change: the packaged project-hosts smoke gives the clean `npm install` of the archive its own fifteen-minute timeout, because that step regularly exceeded the shared three-minute bound on hosted Windows runners during the v1.5 release checks. Install it with the same commands above, replacing `workflow-v1.5` with `workflow-v1.5.1` in the archive URL.

## workflow-v1.5.2 maintenance

This release repairs direct-CLI worker publication (#15), the Windows Codex reviewer command and override (#16), and workflow CLI startup warnings (#17). It also corrects orphaned-attempt recovery instructions (#18) and preserves completion evidence when verbose Claude stream-json output fills the stdout log cap (#20). The npm package version remains 5.5.0. Install it with the commands above, replacing `workflow-v1.5` with `workflow-v1.5.2` in the archive URL.

Worker dispatch now includes structured `publication.publishInvocation` arguments. Custom workers should execute those arguments directly; `publication.publishCommand` is a safe shell fallback only for recognized Node entrypoints and is `null` for unknown launchers. Windows batch shims require the canonical `C:\Windows\System32\cmd.exe` path in this release.

Projects can set editable routing defaults without a controller-specific profile schema: put a short prompt in `.omc/routing.md`. OMC setup projects the instruction to read it into both Claude and Codex lead guidance. For example, a project can adapt this prompt:

> For OMC, use Claude Opus 5.5 as lead, Fable 5.1 for design, GLM 5.3 for implementation (Flash on frozen tasks), Sol 6.0 for packet review (fall back to `gpt-5.6-sol`), and Astra for final review. Review at high effort, ultra for risky work. Verify availability, honor overrides, record actual model/effort/CLI and fallback reason, preserve gates, and attach an attributed PR verdict for external review.

The prompt-first contract is the chosen resolution for #19: project preferences are read each lead session, remain overridable, and the lead records actual model, effort, CLI and fallback reason in workflow evidence. Model-catalog lookup and PR-review attribution are lead actions; this release does not add an automatic catalog resolver or a native PR-review gate. Workflow state, command safety and existing review gates remain enforced by OMC.

### Verbose provider output (#20)

The bounded worker stdout artifact now filters high-volume `system/thinking_tokens` progress records, so a terminal stream-json event remains visible after long reasoning output. Usage telemetry still consumes the untouched full stream. A canonical completed handoff can settle missing terminal framing after ordinary stdout truncation only when the provider exits cleanly and its output closes. An inherited pipe that does not close remains `workflow_output_incomplete` for inspection; failed exits, timeouts, interruptions and failed handoffs remain failures.
### Failed handoffs and shared registries (#21, #22)

A worker whose declared checks fail or whose work exceeds its scope is instructed to publish a failed handoff with the available evidence. The lead can inspect and reject that packet, then create a small follow-up workflow at the integration head with corrected scope and checks to reapply, accept and verify the retained work. This is an explicit workaround; there is no direct `team workflow adopt` command in 1.5.2.

Parallel packets may each prepare changes that require one shared registry update. Keep their write scopes disjoint; after accepting them, a single dependent integration task owns the registry, adds every entry and runs the cross-check. Overlapping independent write scopes remain refused; there is no automatic line-wise merge.
## What changed since workflow-v1.4.1

### Upstream 5.5.0 merge

The fork `main` now contains upstream `main` at `9fd35ece5` (release 5.5.0: 22 features, 24 fixes across 57 upstream PRs). Notable upstream changes that touch this fork's use case:

- Native team lifecycle is bound to an immutable team instance id (upstream #4059); the fork's `src/team/runtime.ts` change was re-applied on top of the rewrite.
- Forwarded credentials stay off every launch command line (upstream #4022) and the read budget is enforced in the pre-tool enforcer (upstream #4055).
- The `jev` judgment-point program, shipyard audit script, `intent` and `diagram` skills, and the HUD rate-limit fallback arrive unchanged from upstream.
- The scale-down validator now accepts persisted `glm` workers, which upstream's provider allowlist had omitted; the fork's GLM route tests were rebased onto the new runtime.
- Windows-only local failures in the npm bin-surface, credential-forwarding launch and worker-launch-ack batch shims reproduce on pristine upstream 5.5.0 and are not introduced by the merge.

### Recovery of attempts orphaned by a dead lead

When a lead process dies while `omc team workflow run`, `resume`, `verify` or `review` is in flight (for example, the Claude Code Bash tool's default two-minute timeout), the shared state could keep a running attempt with a live claim while the checkout operation lock stayed held. V1.5 makes this fail closed and allows explicit recovery after inspection:

- Every attempt records the controller process identity as well as the provider process identity as soon as it spawns.
- `omc orchestrator recover --checkpoint <kind> [--workflow <name>]` releases an abandoned checkout operation lock and host lease only after verifying the owning process has exited. It does not settle a workflow attempt. Live or unverifiable processes still block recovery for inspection.
- Workflow-local stale lock files older than thirty seconds whose owner is dead (including identity-bearing locks) are reaped by quiescence checks. The checkout-wide `operation.lock` requires explicit recovery.
- `omc team workflow reject <name> <task> --reason <text>` validates the reason, settles the orphaned attempt as `workflow_invocation_interrupted`, revokes the attempt's unused publication capability, and drops the task's claim. The task becomes permanently rejected.
- A Claude project launch sets `BASH_DEFAULT_TIMEOUT_MS` and `BASH_MAX_TIMEOUT_MS` to the controller's maximum provider timeout unless the user set them, and the shared host guidance tells leads to give workflow commands the full provider timeout and never to background, kill or retry them.
- The Windows process-identity probe no longer leaks PowerShell's error text when a native process exits before its lease registration completes.

After confirming the controller and provider have exited and inspecting their artifacts, run `orchestrator recover --checkpoint <kind>` to release the lock and lease, then `team workflow reject` to settle the running attempt. A rejected task cannot be retried; add replacement work as a new task, or use `team workflow add-fix` for a review finding.

See the [Claude lead live verification record](WORKFLOW-V1.4-CLAUDE-LEAD-VERIFICATION.md) for the defect evidence and the regression list.

## Verified environments

Hosted CI on the merge head and on the release head ran the full suite plus the host/workflow lifecycle checks on Windows, Linux and macOS. The [lead/worker/reviewer matrix record](WORKFLOW-V1.5-ROLE-MATRIX-VERIFICATION.md) lists the live lanes run on the release candidate with the exact models, what passed and what remains unverified.

## Compatibility

The V1.4 compatibility matrix, setup safety and rollback rules, donor boundary and migration notes in the [V1.4 release notes](WORKFLOW-V1.4-RELEASE-NOTES.md) still apply. The operator guide is [WORKFLOW-V1.4.md](WORKFLOW-V1.4.md).
