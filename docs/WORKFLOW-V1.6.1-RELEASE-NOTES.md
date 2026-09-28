# Workflow V1.6.1 release notes

`workflow-v1.6.1` is a maintenance release for the workflow process-evidence gap tracked in [#48](https://github.com/kachiuli/oh-my-claudecode/issues/48) and the Windows standalone state-lock bridge path bug tracked in [#49](https://github.com/kachiuli/oh-my-claudecode/issues/49). The package version remains 5.5.0; `workflow-v1.6.1` is a custom GitHub release tag and is not published as a new npm registry version.

## Install this custom release

Install the archive attached to the `workflow-v1.6.1` GitHub release:

```sh
npm install -g https://github.com/kachiuli/oh-my-claudecode/releases/download/workflow-v1.6.1/oh-my-claude-sisyphus-workflow-v1.6.1.tgz
omc setup --host both --scope project
omc orchestrator use claude
omc launch
```

## Persisted process observations

When a new implementer or reviewer process returns, the workflow now persists a strictly validated, output-free `processResult` tied to that invocation. It records the actual process-runner result: `passed`, an optional `error`, `parentExitedSuccessfully`, and `stdoutTruncated`. When the process runner directly observed settlement, the snapshot also includes its optional `settlement` record for the parent exit, output completion, termination attempt, direct child, and descendants.

The workflow saves this snapshot before downstream handoff, task-test, or review-result validation. A later validation failure therefore does not discard the process observations that were already available when the provider returned. The saved snapshot contains no stdout, stderr, prompts, credentials, or artifact contents.

## Windows standalone bridge path fix

The standalone-installed state-lock bridge now constructs its package manifest and helper paths with the platform path API before canonical identity validation. This prevents Windows from rejecting a valid package only because its canonical root uses backslashes while an appended child path used a forward slash.

The existing canonical-root, regular-file, package name/version, reparse, and helper-containment checks remain in place. The install sequence above reruns `omc setup` and regenerates the corrected standalone bridge.

## Compatibility and limits

- Historical invocations, older pinned workflow states, and interrupted invocations that never reached the persistence point remain without `processResult`; absence means unknown and is never backfilled.
- A missing optional `settlement` remains unknown. Status, task completion, dead-process checks, or later recovery do not synthesize it or retroactively certify an execution.
- The snapshot records observed process facts only. It does not change provider pass/fail semantics, validation gates, retry behavior, review accounting, budgets, timeout policy, prompt handling, or artifact redaction.
- Existing workflow state remains readable, including invocations without the new field.

See the [V1.6 release notes](WORKFLOW-V1.6-RELEASE-NOTES.md) for the workflow controls and compatibility rules carried forward unchanged, and the [workflow operator guide](WORKFLOW-V1.4.md) for command-level guidance.
