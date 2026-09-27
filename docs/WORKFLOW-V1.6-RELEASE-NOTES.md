# Workflow V1.6 release notes

`workflow-v1.6` keeps Claude Code or Codex as the repository lead and simplifies four fork-specific controls without weakening the existing scope, verification, and review gates. The package version remains 5.5.0; `workflow-v1.6` is the custom workflow release label.

## Install this custom release

Use the archive attached to the `workflow-v1.6` GitHub release:

```sh
npm install -g https://github.com/kachiuli/oh-my-claudecode/releases/download/workflow-v1.6/oh-my-claude-sisyphus-workflow-v1.6.tgz
omc setup --host both --scope project
omc orchestrator use claude
omc launch
```

The archive keeps package version 5.5.0 and records the tagged source commit in `gitHead`. Its release evidence records the archive checksum and file manifest. This custom release does not replace the upstream npm registry package.

## Completed reviews are the checkpoint

New workflows still default to an initial review plus one re-review. Their allowance now counts completed reviews instead of every reviewer invocation. A failed invocation remains in the immutable attempt history and status reports invocation count, completed reviews, budget basis, and budget used separately. An incomplete or interrupted invocation still blocks another review and remains available for inspection; a failure is not silently treated as a successful checkpoint.

The initial `--max-review-passes` value remains bounded at ten. An attributed `extend-review-budget` request can raise the current ceiling by at most ten at a time, while repeated authorized extensions no longer encounter a universal lifetime ceiling. New workflows apply that ceiling to completed reviews; historical state keeps attempt-based accounting. Each extension still requires the exact clean HEAD, an idle controller, an exhausted current allowance, a unique request ID, and an authority record. It does not launch a reviewer or waive findings, verification, or finish gates.

Existing saved workflows are not migrated. A state without the v1.6 `completed-reviews` accounting marker keeps the earlier rule in which each reserved review attempt consumes its allowance. Its saved bytes and history remain authoritative.

## Inspect and revalidate retained task work

`omc team workflow inspect-task <name> <task-id>` gives the lead a bounded, read-only classification of a retained task. It reports an opaque all-ref digest, saved and observed commit IDs, and clean/registered state without returning private paths or ref names. It does not run a provider or mutate the workflow.

For a `recoverable-completed-handoff`, `recover-task <name> <task-id> --file <intent.json>` revalidates the exact retained single-parent commit against its original base, changed-file list, scope, completed handoff, worker test evidence, and saved local checks. It requires the exact clean integration HEAD and unchanged all-ref digest. A successful operation appends an attributed present-day receipt and changes the task from failed to completed even when its provider attempts are exhausted. The lead still runs the normal separate `accept` operation.

Recovery does not rewrite the original failure, attempt, invocation, handoff, or audit evidence. Failed handoffs, dirty or changed worktrees, scope escapes, missing evidence, live or unverifiable processes, and failed rerun checks remain refused. An intact non-overflowing protected-ref audit with `writer: "unknown"` may support a new revalidation; the receipt does not retroactively prove who changed the ref. Ref-audit artifacts add bounded worker observation context that remains explicitly non-attributive.

## Bounded GLM identity evidence (#46)

Every GLM assistant event now contributes to identity validation, even when its session ID, model ID, or both are absent. Missing fields produce bounded diagnostics and make `identityEvidenceComplete` false; an identified event elsewhere in the stream cannot mask the omission. A truncated capture still cannot certify the unseen stream, and historical summaries that omitted such events remain observational rather than retroactive proof.

## Lead integration after an exhausted checkpoint

An attributed `integrate-lead` commit may now be recorded after the current review allowance is exhausted. This supports the ordinary sequence in which the lead applies one small approved correction, records its exact commit and checks, then obtains authority for another review of the changed HEAD.

The operation still accepts only one direct child of the saved integration HEAD with an exact changed-file list, clean integration checkout, matching lead identity where available, passing finite checks, and unchanged refs during those checks. It invalidates prior verification and requires fresh verification and review before `finish`. It does not itself add review allowance; append an authorized extension against the new HEAD when another completed review is required.

## Effective routing and receipt-covered refresh

`omc team workflow routing <name>` reports the saved effective lead, implementer, and reviewer selections, including provider, model, effort, CLI family, credential-profile reference, and whether the selection came from initialization or a substitution. It does not load the private runtime or expose executable paths, authentication fingerprints, receipt hashes, environment values, or credentials. Legacy workflows report a `legacy-snapshot` source rather than guessing how a route was originally selected.

Schema-2 workflows add `probe-binding` and `refresh-binding` for a narrow convenience case: derive a new binding ID and model/effort selection from the current binding when its existing authenticated receipt already covers that exact combination. Probe is read-only and makes no provider call. Refresh repeats validation under the mutation lock and appends the result through the existing substitution history, so only future invocations change.

These commands do not mint authentication evidence, switch provider, change executable or profile identity, rewrite a private runtime file, or choose a fallback. An uncovered model or effort requires a trusted bounded validation run and new authenticated evidence before the existing full substitution path can select it.

## Provider timeout policy naming

New initialization saves the descriptive `unbounded-provider-timeout` policy name. The earlier `supervised` spelling remains an accepted initialization alias and remains valid byte-for-byte in previously saved states. Status exposes both the raw saved `providerPolicy` and its `effectiveProviderPolicy`; omission means `finite-provider-timeout`.

The policy still removes only the implementer/reviewer elapsed bound. Worker-declared checks and integrated verification retain the saved finite timeout. It adds no progress monitoring or provider cancellation mechanism.

## Compatibility and limits

- Existing V1/V2 workflow states remain readable without an implicit accounting or policy migration.
- Review findings, failed invocation evidence, provider telemetry, substitutions, and earlier extension receipts remain append-only.
- V1.6 does not turn a failed or interrupted reviewer invocation into a completed review, automatically retry it, or infer authority for another review.
- Provider monitoring, cancellation, and authenticated model availability remain separate concerns.

The [workflow operator guide](WORKFLOW-V1.4.md) contains the command-level guards. The [v1.5 release notes](WORKFLOW-V1.5-RELEASE-NOTES.md) remain the history for worktree recovery, lead integration, worker telemetry, dispatch supplements, literal route scopes, and the first review-extension operation.
