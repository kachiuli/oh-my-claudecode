# Workflow V1.4 repository hosts

Workflow V1.4 lets one repository use Claude Code or Codex as the interactive OMC lead. The selected host is independent of workflow provider bindings: changing the lead does not change which provider implements or reviews a task. The workflow label does not change the npm package version, which follows upstream (5.4.0 at the original release, 5.5.0 after the September 2026 upstream merge); `workflow-v1.4` is the workflow release label.

The explicit operation-lock recovery, advisory hook diagnostics and Windows shipping fixes below are maintenance changes after the original `workflow-v1.4` tag and ship in `workflow-v1.4.1`. The Claude lead Bash-timeout default and the settlement of attempts orphaned by a dead controller are later maintenance changes validated by the [Claude lead live record](WORKFLOW-V1.4-CLAUDE-LEAD-VERIFICATION.md); they ship in `workflow-v1.5` together with the upstream 5.5.0 merge and are not in the earlier archives.

## Install both project hosts

Run setup from the repository root. Project setup does not modify the user's global Claude, Codex, Anthropic, OpenAI, or Z.AI configuration.

```sh
omc setup --host both --scope project --dry-run
omc setup --host both --scope project
omc doctor hosts
omc orchestrator status
```

Setup is idempotent. Refresh managed projections after updating the installed OMC package:

```sh
omc update --host both --scope project
```

Setup refuses unowned generated-file collisions, symbolic links, hard-linked targets, malformed receipts, and modified managed blocks. A failed setup or configuration update rolls back every asset mutation made by that operation. Successful changes retain point-in-time backups under `.omc/hosts/backups/`.

Setup adds an owned `.gitignore` block for `.omc/state/` and `.omc/hosts/`. In a repository without broader ignore rules, `.omc/orchestrator.json` remains visible so the supported-host declaration can be committed. Existing user ignore rules for other paths keep their original meaning. If the repository already ignores all of `.omc`, deliberately stage the shared declaration with `git add -f .omc/orchestrator.json`.

## Installed surfaces

| Path                                                                                      | Purpose and ownership                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.omc/orchestrator.json`                                                                  | Repository-local configuration: supported hosts and optional default.                                                                                 |
| `.gitignore`                                                                              | Marker-bounded rules that ignore local `.omc/state/` and `.omc/hosts/` data. Existing rules are retained.                                             |
| Effective OMC state root, `state/orchestrator/repositories/<repository-key>/runtime.json` | Ignored selection, lease and checkpoint for one physical Git checkout. `OMC_STATE_DIR` and workspace-root resolution can relocate this runtime state. |
| Effective OMC state root, `state/orchestrator/operation.lock`                             | Operation gate shared by repositories that use the same workspace state root.                                                                         |
| `.omc/hosts/receipt.json`                                                                 | Hashes and exact managed content used by update, doctor and uninstall.                                                                                |
| `.omc/hosts/claude/plugin/`                                                               | Project Claude plugin with OMC skill, role agents, MCP pointer and lifecycle hooks.                                                                   |
| `.omc/hosts/codex/plugin/`                                                                | Project Codex compatibility plugin with OMC skill and lifecycle hooks.                                                                                |
| `.agents/plugins/marketplace.json`                                                        | Repository marketplace entry for the Codex plugin. Existing marketplace entries and the marketplace name are retained.                                |
| `CLAUDE.md`, `AGENTS.md`                                                                  | Marker-bounded projections of the same shared guidance source. Surrounding user text is retained.                                                     |
| `.codex/config.toml`                                                                      | Marker-bounded OMC MCP server and repository plugin enablement. Existing settings are retained.                                                       |
| `.codex/hooks.json`                                                                       | Exact managed native lifecycle entries merged with existing user hooks.                                                                               |
| `.agents/skills/omc-orchestration/`                                                       | Codex skill fallback when the repository plugin has not yet been refreshed or installed.                                                              |
| `.codex/agents/`                                                                          | Codex-native projections of the installed OMC role catalog. Model settings are not pinned.                                                            |

A parent `.omc-workspace` marker relocates runtime and session files to the shared workspace state root. Configuration, managed assets and native launch cwd remain in the physical Git checkout. Each checkout uses a stable key derived from its canonical root, so selecting a host or recording a native session in one sibling repository does not change another sibling's selection. The shared operation lock still serializes mutations of shared workflow state.

The Claude launcher passes the managed plugin with `--plugin-dir`. Codex discovers the repository marketplace and project enablement in a trusted repository. Codex may require a restart or marketplace refresh before a changed local plugin copy is loaded. Native and plugin hooks require the user's exact hook-definition trust. The OMC operation, lease, publication and protected-ref gates remain authoritative when hooks are unavailable, disabled, untrusted, or bypassed by a hosted tool.

## Select and launch

```sh
omc orchestrator use codex
omc launch

omc orchestrator use claude
omc launch
```

`omc launch` starts the selected native executable directly with argument arrays and inherited stdio. It does not invoke a shell. The existing OMC notification options (`--notify`, `--openclaw`, `--telegram`, `--discord`, `--slack`, and `--webhook`) remain available and are translated before the native host starts.

For Codex, OMC fixes the working directory at the repository root and defaults to `workspace-write`; an explicit `read-only` sandbox remains read-only. Explicit workspace expansion, remote-host redirection, sandbox bypass flags, sandbox-changing `-c` overrides, conflicting `--full-auto` plus `read-only`, and the unmanaged `app`, `queue`, `agents`, and `exec-server` entry points are refused. Existing native user/profile configuration still applies, including its permission, readable-root, and network settings. Core workflow gates separately enforce OMC task write scopes, leases, result publication, and protected refs.

Claude keeps the user's model and permission settings while adding the managed project plugin. Because the native Bash tool stops a command after two minutes by default, which kills `omc team workflow run` mid-attempt, a Claude project launch sets `BASH_DEFAULT_TIMEOUT_MS` and `BASH_MAX_TIMEOUT_MS` to the controller's maximum provider timeout of one hour unless the user already set them. Adopted project hosts reject `--madmax`, `--yolo`, and native permission-bypass aliases. Alternate remote, cloud, attach, teleport, background, safe, bare, `agents`, and `ultrareview` modes are unsupported because they do not preserve the registered local lead session and repository lease. The only supported continuation form is `omc launch --resume <native-session-id>`.

To resume, use only a native session that OMC recorded for the same host and selection:

```sh
omc launch --resume <native-session-id>
```

Host sessions are not provider worker sessions. A Claude session cannot resume as Codex, a session recorded in one repository cannot resume another repository, and a host switch starts a fresh native conversation while keeping the OMC workflow checkpoint.

## Switch safely

After the old host exits and the repository is quiescent, select the other host with `omc orchestrator use`. Selection fails while a provider process, active attempt, operation lock, or host lease remains.

From the active host session, an explicit handoff records a safe boundary and revokes that session before selecting the destination:

```sh
omc orchestrator handoff codex --checkpoint completed-stage --workflow <name> --reference <evidence>
```

Accepted checkpoint kinds are `before-work`, `completed-stage`, `paused`, and `checkpointed`. A stale or cross-host native session cannot mutate the controller after handoff.

If a lead or operation process crashes, stop any remaining host or provider work, then request explicit recovery:

```sh
omc orchestrator recover --checkpoint paused --workflow <name> --reference <evidence>
```

`recover` can clear a verifiably abandoned operation lock as well as a host lease. It checks process identities, repository ownership, registered host processes, sibling repository leases and shared workflow activity before changing state. Recovery also handles an operation that crashed without creating a lease, such as setup or selection. It records the supplied checkpoint and recovery evidence without completing tasks or rewriting workflow history.

Normal commands never expire or reap operation locks. Recovery refuses live or unverifiable owners, incomplete process registration, active work, malformed or legacy lock records, and ownership conflicts. An abandoned recovery claim also remains blocked; a second crash during recovery requires inspection. These refusals preserve the files for diagnosis rather than guessing that their owners are gone. Run recovery from the owning physical checkout and retain the error and state for investigation; do not delete state directories to force progress.

A lead that dies while `omc team workflow run` or `resume` is executing leaves the task `running` and the controller's advisory `workflow.json.lock` behind. Two independent rules cover that state. Each attempt records the controller's process identity when it is reserved and the provider's identity at spawn. `orchestrator recover --checkpoint <kind>` releases the abandoned checkout operation lock and host lease after verifying the owner has exited; it does not settle the task. Explicit `team workflow reject` checks the recorded provider (or, before spawn, the controller) and settles the orphaned attempt only after verified exit. Separately, every quiescence check treats an advisory `*.lock` file as abandoned rather than held once it is at least 30 seconds old and its recorded owner is verifiably gone, which is the same rule the lock applies before reaping the file itself. Selection and handoff still refuse a running task until it is settled. Exit the dead lead's session, run `omc orchestrator recover --checkpoint <kind>` from a plain shell, then settle the interrupted task explicitly:

```sh
omc team workflow reject <name> <task-id> --reason <inspection-summary>
```

The attempt is recorded as `workflow_invocation_interrupted`, its unused publication capability is revoked, and it is never re-dispatched automatically; remaining tasks continue or the workflow is abandoned. Attempts whose provider or controller is still alive, or whose identities cannot be verified, remain blocked for inspection.

A worktree setup failure before provider launch is recorded separately as `workflow_worktree_setup_failed`; it does not consume a provider attempt or create an invocation, claim, or session. Status shows the private artifact path and, when Git supplies an allowlisted refusal code, that safe detail. Inspect the artifact, repair the Git or filesystem condition, then run `omc team workflow run <name>` again. Setup history is append-only, so the failed checkout and later successful retry remain separate from provider attempts and keep the dependency base selected before the first setup.

## Failed packets and shared files

Inspect a failed task before changing it:

```sh
omc team workflow inspect-task <name> <task-id>
```

This read-only command returns one bounded classification, a next action, an opaque digest of the current all-ref snapshot, the saved and observed commit IDs, and clean/registered booleans. It does not dispatch a provider, change state, or expose worktree paths or ref names. `active`, `unverifiable`, `dirty-partial`, `failed`, and `missing` remain blocked or require manual inspection. Only `recoverable-completed-handoff` is eligible for controller revalidation.

For that classification, copy `expectedRefsDigest` and `savedHead` from the inspection, obtain the current clean integration commit with `git rev-parse HEAD`, and create an intent:

```json
{
  "requestId": "recover-backend-1",
  "expectedHead": "0123456789abcdef0123456789abcdef01234567",
  "expectedRefsDigest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "expectedTaskCommit": "89abcdef0123456789abcdef0123456789abcdef",
  "actor": { "id": "unknown", "model": "unknown" },
  "authorityRef": "approved-retained-task-revalidation",
  "reason": "Revalidate the exact retained completed handoff."
}
```

Then run:

```sh
omc team workflow recover-task <name> <task-id> --file <intent.json>
omc team workflow accept <name> <task-id>
```

Recovery requires an idle controller, clean integration checkout at the exact saved HEAD, unchanged all-ref digest, a clean registered task worktree, and an exact retained single-parent commit whose changed files remain within the original scope. The saved handoff must already say `outcome: "completed"`, list that commit and changed files, and contain passing evidence for every declared worker test. OMC reruns the original task checks in the retained worktree with the saved finite timeout. If they pass without repository drift, it appends an attributed present-day receipt and changes the task from `failed` to `completed`. Attempts may already be exhausted. The original failure, attempts, invocations, handoff and artifacts remain unchanged, and `accept` remains the separate integration decision.

A worker-declared failed handoff, missing result, dirty or moved worktree, changed commit, scope escape, live/incomplete process, failed check, or mismatched refs cannot use this path. Preserve that evidence. When the saved task contract no longer fits, reject it with a reason and initialize a small follow-up workflow at the current integration head; have a new task reapply the work within corrected scope and checks. A lead-side cherry-pick alone is not controller acceptance.

For `workflow_protected_refs_changed`, recovery is available only when the retained audit is intact, non-overflowing, and still records `writer: "unknown"`. Revalidation records a new present-day decision; it does not rewrite the original audit or retroactively identify, blame, or clear a writer. Audit entries now include bounded active/completed worker observation context, explicitly labelled as context rather than writer attribution.

For independent packets that each need an entry in one append-only registry, omit the registry from their write scopes. Run the packets in parallel and accept them. Add one integration task whose `dependencies` list contains every packet and whose `writeScope` exclusively owns the registry path. That task appends all entries and runs the cross-check after its dependencies are accepted. Overlapping write scopes between independent tasks remain refused; the controller does not line-merge competing commits.

When an accepted dependency reveals one bounded clarification needed by a still-unstarted dependent task, use `omc team workflow supplement <name> --file <intent.json>`. This balanced-workflow operation records the exact saved input HEAD, lead actor (or the `unknown` pair), authority, reason, UTF-8 content, and SHA-256 digest. The controller permits one supplement per pending dependent task only after all its dependencies are accepted. It leaves the original task and plan unchanged, includes the receipt in that task's prompt and fingerprints, and pins the task's first setup to the recorded input HEAD.

For one small lead-authored integration commit after every task is settled, create exactly one direct child of the saved integration HEAD and run `omc team workflow integrate-lead <name> --file <integration.json>`. The file declares the exact parent, head, paths, checks, actor/model (or `unknown` for both), authority reference, and reason. The controller requires the clean integration branch, operation ownership, unchanged refs during checks, and a matching single-commit diff; it then appends evidence and invalidates verification. Normal verification and a fresh review of the new HEAD are still required. V1.6 permits this integration at an exhausted review checkpoint so the lead can record the correction first, then append review authority against the new HEAD and run verification and review. Integration itself neither extends nor consumes the review budget. This operation cannot prove whether an unrelated ref changed before it began; use a normal task when that earlier history matters.

For workflows created by V1.6, the default limit applies to completed reviews. Failed reviewer invocations remain in `reviewAttempts` and increment the invocation counter, but do not spend completed-review authority; status reports `reviewPasses`, `completedReviews`, `reviewBudgetBasis`, and `reviewBudgetUsed` separately. An incomplete or interrupted invocation still blocks another review and remains available for inspection. Historical workflows without the V1.6 accounting marker retain attempt-based accounting exactly as saved.

When every authorized budget unit has been consumed but another correction cycle is explicitly approved, run `omc team workflow extend-review-budget <name> --file <intent.json>`. A budget unit is a completed review for a workflow created by V1.6 and a reserved review attempt for historical state without the new accounting marker. The intent supplies a unique `requestId`, exact `expectedHead` and `expectedCeiling`, a positive `increment`, the lead actor (or the `unknown` pair), authority reference, and reason. The controller requires the idle, clean integration checkout and an exhausted budget. Each request may raise the current ceiling by at most 10, but repeated attributed extensions have no cumulative lifetime ceiling. The controller appends an immutable receipt without changing the initial `maxReviewPasses`, invocation count, completed reviews, findings, attempts, verification, or stage. It does not dispatch a reviewer or waive any review, adjudication, verification, or finish gate. Replaying the identical request is a no-op; reusing its ID with different content or submitting a stale ceiling is refused.

A controller pinned before this operation cannot extend an existing workflow honestly. Leave its workflow state and artifacts intact, report the exhausted ceiling, and update the controller pin to a release that supports `extend-review-budget` before applying an authorized intent to the same saved workflow. If the controller cannot be upgraded, the workflow remains blocked at its exhausted ceiling. Do not edit `workflow.json`, reset counters, discard review history, or create a replacement workflow to evade the budget.

## Git refs during a live run

The leader checkout and every linked `git worktree` share one repository's refs. While `omc team workflow run` or `resume` is active, only assigned task-branch commits should change refs in those checkouts. Avoid unrelated `git fetch`, branch or tag changes, and other ref-writing Git commands. Do separate Git work in an independent clone. The protected-ref audit observes repository-level changes, even to refs no task reads, and an unexpected change fails the candidate batch. Its `writer: "unknown"` means the audit cannot identify the checkout or process that wrote the ref; inspect the retained audit artifact and linked-worktree activity before assigning cause. Do not bypass the audit or assume a clean candidate can be accepted after it fails; use the failed-packet recovery path above.

## Provider and model independence

Host selection never infers a provider from a model name. Existing explicit workflow bindings remain authoritative. `omc team workflow routing <name>` gives a sanitized read-only view of the effective saved selections and their initialization/substitution source without loading private runtime data or calling a provider. For schema-2 workflows, `probe-binding` and `refresh-binding` can derive only a model/effort choice already covered by the current binding's authenticated receipt; see the [role-substitution guide](GLM-WORKFLOW-V1.2.md#preview-and-refresh-a-receipt-covered-route). They do not authenticate a model, change provider identity, or select a fallback. The Z.AI identifiers supported by this release are preserved exactly:

- `glm-5.3`
- `glm-5.3-flash`
- `glm-5.3-flash[1m]`

OMC does not normalize suffixes or route by model-name substring. OpenAI, Anthropic and Z.AI authentication stays in each provider's private configuration. Setup and diagnostics do not read or print credential values.

## Uninstall and migration

Select or install another host before removing an inactive host:

```sh
omc orchestrator use codex
omc uninstall --host claude --scope project
```

Uninstall removes only content that still matches the receipt. It preserves modified managed files, user text, user hooks, other marketplace entries, the other host and shared workflow state. Removing the active host or the final supported host fails closed.

Existing OMC workflow state needs no migration. Reads do not backfill historical host fields, and project adoption does not rewrite existing workflows. `.omx` belongs to a different product schema: Workflow V1.4 does not import arbitrary OMX state and refuses simultaneous live OMX/OMC ownership. Finish an existing OMX workflow in OMX, then initialize or resume the OMC workflow separately.

## Diagnose lifecycle support

`omc doctor hosts` verifies the receipt, managed content, native CLI discovery and reported Codex hook capability. Each host's `hookDiagnostics` separates CLI capability, installed definitions and accepted hook execution. `nativeTrust` remains `not-established`: OMC does not inspect or change the host's private trust store.

For a Codex CLI that reports hook support, open the repository as a trusted project and review new or changed definitions with `/hooks`. Approve the definitions in Codex, exercise a lifecycle event, then rerun `omc doctor hosts`. If the CLI is missing or does not advertise support, follow the installation or upgrade guidance first. Installation or a healthy asset check alone does not establish hook approval. Refresh or restart Codex when a changed local plugin has not yet loaded.

Execution evidence is advisory. It is scoped to the physical repository, host, configuration, selection and managed hook definitions; changing those makes older evidence stale. An `observed` result records an accepted hook event, but does not prove present native trust, provider authentication or a successful model call. Missing, stale, malformed or unavailable observations never grant or revoke workflow authority. If runtime selection cannot be read, asset diagnostics remain available and recommend `omc orchestrator status` for investigation. The core operation, lease and publication checks continue to apply.

## Verify shipping files on Windows

The shipping verifier reads the committed Git tree using a bounded command and compares the exact required paths locally. Staging passes literal paths through Git's NUL-delimited input, avoiding Windows command-line limits while preserving spaces, Unicode and pathspec characters. The same shipping regression suite runs on Windows, Linux and macOS.

```sh
npm run plugin:shipping:verify
```

Primary references:

- [Codex advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex plugin packaging and repository marketplaces](https://developers.openai.com/plugins/build/plugins)
- [Codex skills](https://learn.chatgpt.com/docs/build-skills)
- [Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Claude Code plugins](https://code.claude.com/docs/en/plugins)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Z.AI GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3)
- [Z.AI GLM-5.3 Flash](https://docs.z.ai/guides/vlm/glm-5.3-flash)
- [Z.AI latest-model aliases](https://docs.z.ai/devpack/latest-model)
