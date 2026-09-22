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

## What changed since workflow-v1.4.1

### Upstream 5.5.0 merge

The fork `main` now contains upstream `main` at `9fd35ece5` (release 5.5.0: 22 features, 24 fixes across 57 upstream PRs). Notable upstream changes that touch this fork's use case:

- Native team lifecycle is bound to an immutable team instance id (upstream #4059); the fork's `src/team/runtime.ts` change was re-applied on top of the rewrite.
- Forwarded credentials stay off every launch command line (upstream #4022) and the read budget is enforced in the pre-tool enforcer (upstream #4055).
- The `jev` judgment-point program, shipyard audit script, `intent` and `diagram` skills, and the HUD rate-limit fallback arrive unchanged from upstream.
- The scale-down validator now accepts persisted `glm` workers, which upstream's provider allowlist had omitted; the fork's GLM route tests were rebased onto the new runtime.
- Windows-only local failures in the npm bin-surface, credential-forwarding launch and worker-launch-ack batch shims reproduce on pristine upstream 5.5.0 and are not introduced by the merge.

### Recovery of attempts orphaned by a dead lead

When a lead process dies while `omc team workflow run`, `resume`, `verify` or `review` is in flight (for example, the Claude Code Bash tool's default two-minute timeout), the shared state used to keep a running attempt with a live claim while the operation lock stayed held, and neither `recover` nor `reject` could settle it. V1.5 makes this fail closed but recoverable:

- Every attempt records the controller process identity as well as the provider process identity as soon as it spawns.
- `omc orchestrator recover` treats a running attempt as orphaned only when the recorded provider (or, before spawn, the controller) is verifiably dead, the invocation is the task's current attempt, and the workflow and task projections live under the workflow's own state directory. Live or unverifiable processes still block recovery for inspection.
- Abandoned lock files older than thirty seconds whose owner is dead (including identity-bearing locks) are reaped by every quiescence check instead of wedging later commands.
- `omc team workflow reject <name> <task> --reason <text>` validates the reason, settles the orphaned attempt as `workflow_invocation_interrupted`, revokes the attempt's unused publication capability, and drops the task's claim; the attempt is never re-dispatched.
- A Claude project launch sets `BASH_DEFAULT_TIMEOUT_MS` and `BASH_MAX_TIMEOUT_MS` to the controller's maximum provider timeout unless the user set them, and the shared host guidance tells leads to give workflow commands the full provider timeout and never to background, kill or retry them.
- The Windows process-identity probe no longer leaks PowerShell's error text when a native process exits before its lease registration completes.

See the [Claude lead live verification record](WORKFLOW-V1.4-CLAUDE-LEAD-VERIFICATION.md) for the defect evidence and the regression list.

## Verified environments

Hosted CI on the merge head and on the release head ran the full suite plus the host/workflow lifecycle checks on Windows, Linux and macOS. The [lead/worker/reviewer matrix record](WORKFLOW-V1.5-ROLE-MATRIX-VERIFICATION.md) lists the live lanes run on the release candidate with the exact models, what passed and what remains unverified.

## Compatibility

The V1.4 compatibility matrix, setup safety and rollback rules, donor boundary and migration notes in the [V1.4 release notes](WORKFLOW-V1.4-RELEASE-NOTES.md) still apply. The operator guide is [WORKFLOW-V1.4.md](WORKFLOW-V1.4.md).
