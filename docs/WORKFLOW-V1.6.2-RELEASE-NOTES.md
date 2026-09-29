# Workflow V1.6.2 release notes

`workflow-v1.6.2` is a maintenance release for the task-notification usage-evidence defect tracked in [#51](https://github.com/kachiuli/oh-my-claudecode/issues/51) and released in response to [#53](https://github.com/kachiuli/oh-my-claudecode/issues/53). The package version remains 5.5.0; `workflow-v1.6.2` is a custom GitHub release tag and is not published as a new npm registry version.

## Install this custom release

Install the archive attached to the `workflow-v1.6.2` GitHub release:

```sh
npm install -g https://github.com/kachiuli/oh-my-claudecode/releases/download/workflow-v1.6.2/oh-my-claude-sisyphus-workflow-v1.6.2.tgz
omc setup --host both --scope project
omc orchestrator use claude
omc launch
```

## Task-notification usage evidence

The Claude Agent SDK can emit one ordinary main result followed by successful results whose origin is `task-notification`. The usage collector now recognizes that sequence when every additional result is correlated with exactly one completed task notification in the same session. Repeated, identical cumulative usage snapshots count once, so background-task notifications no longer multiply the invocation's token totals or make otherwise valid identity evidence incomplete.

The existing single-result path remains compatible. An ordinary result with no origin, a null origin, or a human origin is still treated as the one main result, and workflows that do not use background tasks retain their previous accounting behavior.

## Fail-closed boundaries

Additional results are accepted only as task-notification results after the main result. The collector rejects extra main results; missing, unknown, duplicate, failed, unresolved, or ambiguous tasks and notifications; unknown or mismatched origins; invalid task or tool-use identities; session or model conflicts; malformed or incomplete streams; and inconsistent cumulative usage. Multi-result streams must also contain sufficient initialization and model evidence. Rejected streams cannot claim complete identity or accounting evidence.

Persisted telemetry records bounded aggregate evidence: terminal counts, session and model observation counts, and terminal usage buckets. Task identities and the event-by-event pairing between a notification and its result are validated while the stream is collected but are not stored for later replay. State validation can therefore prove that the saved aggregates are internally consistent; it cannot independently reconstruct that original task correlation from persisted telemetry alone.

See the [V1.6.1 release notes](WORKFLOW-V1.6.1-RELEASE-NOTES.md) for the process-evidence and Windows bridge fixes carried forward unchanged, the [V1.6 release notes](WORKFLOW-V1.6-RELEASE-NOTES.md) for the workflow controls and compatibility rules, and the [workflow operator guide](WORKFLOW-V1.4.md) for command-level guidance.
