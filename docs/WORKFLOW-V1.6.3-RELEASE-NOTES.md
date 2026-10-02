# Workflow V1.6.3 release notes

`workflow-v1.6.3` is a maintenance release for fresh-clone project setup ([#55](https://github.com/kachiuli/oh-my-claudecode/issues/55), [#56](https://github.com/kachiuli/oh-my-claudecode/issues/56)), foreground shell usage evidence ([#57](https://github.com/kachiuli/oh-my-claudecode/issues/57)), and tracked routing-policy integration ([#58](https://github.com/kachiuli/oh-my-claudecode/issues/58)). The package version remains 5.5.0; this is a custom GitHub release, not a new npm registry version.

## Install this custom release

```sh
npm install -g https://github.com/kachiuli/oh-my-claudecode/releases/download/workflow-v1.6.3/oh-my-claude-sisyphus-workflow-v1.6.3.tgz
omc setup --host both --scope project
omc orchestrator use claude
omc launch
```

Select `--host codex` and `omc orchestrator use codex` for a Codex-only project. The archive records its exact source commit in `package.json`'s `gitHead`; the accompanying release evidence records the file manifest and SHA-256 checksum. Rebuild source checkouts before using their compiled CLI: the release archive contains the rebuilt runtime.

## Portable project setup

Ordinary project setup can establish a fresh machine-local ownership receipt when a repository already contains exactly the current generated project guidance or project-state ignore block, allowing LF/CRLF line-ending conversion by Git. It preserves the existing file bytes during adoption and records those actual block bytes in the local receipt; dry-run remains non-mutating. There is no need to copy another machine's receipt or temporarily remove tracked blocks.

This applies only to portable guidance and project ignore fragments. It does not adopt arbitrary generated files or machine-specific MCP configuration. Modified, unknown, duplicated, incomplete, embedded or non-matching fragments still fail closed, as do malformed receipts, unsafe filesystem targets and generated-file collisions. Templates from a different release are not assumed to be equivalent.

## Foreground shell telemetry

A positively identified foreground `local_bash` task with a matching successful completion can settle its own shell lifecycle without a task-origin LLM result. It does not create a terminal model result or invent token usage; accounting still comes from the provider's actual main result. Task, tool-use, session, model and stream consistency checks remain enforced.

Agent task notifications still require their matching task-origin model result. Failed or unresolved tasks, unknown/background task classifications, duplicate or ambiguous notifications, and conflicting identities cannot use the foreground-shell exception. Earlier saved partial telemetry remains unchanged; upgrading does not retroactively certify prior runs.

## Gated routing-policy integration

`integrate-lead` accepts the exact root-relative path `.omc/routing.md` as tracked repository policy source. The file must be committed at the proposed head as a regular file, with safe directory and working-tree identity and content matching the proposed Git blob. Hidden index flags cannot substitute unchecked policy bytes. Existing quiescence, exact one-child parent/head, literal changed-file scope, check execution, history and review gates still apply.

The exception does not open `.omc` directories, runtime state or worker write scopes. Review findings can name the exact routing-policy file. This does not add worker remediation for that file or bypass unresolved findings: a policy finding marked `fix` remains blocking under the existing adjudication rules. Lead policy changes must pass the normal integration and subsequent verification/review gates. Alternate spellings, nested `.omc` paths, unsafe filesystem targets and deleting the policy through this path remain rejected.

## Verification scope

These changes are covered by offline regressions and package checks. No live provider invocation or consumer-workflow completion is implied. The [V1.6.2 task-result accounting rules](WORKFLOW-V1.6.2-RELEASE-NOTES.md), [V1.6.1 process-evidence limits](WORKFLOW-V1.6.1-RELEASE-NOTES.md), and [workflow operator guide](WORKFLOW-V1.4.md) continue to apply.
