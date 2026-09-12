# Claude lead, GLM workers, Codex review

This opt-in V1 assigns planning and integration to the Claude Code lead, bulk
implementation to local GLM wrappers, and independent final review to Codex CLI.
Without this profile, normal OMC routing and provider defaults remain unchanged.

Start with the [README setup and first-run instructions](../README.md#glm-workflow-v1-fork-setup)
to build this fork, configure the separate GLM profile, and understand the current
validation limits. This guide supplies the detailed plan and command reference.

## Configure the local provider

Add the following to your OMC configuration (`.claude/omc.jsonc` in the project or
`~/.config/claude-omc/config.jsonc` for the user):

```json
{
  "team": {
    "profile": "claude-glm-codex",
    "glm": {
      "command": "claude-glm",
      "fallback": false,
      "defaultWorkers": 4,
      "maxWorkers": 6
    }
  }
}
```

`command` is one executable name on PATH or an absolute executable path, never a
shell command containing arguments. `OMC_GLM_COMMAND` overrides it. An optional
`externalModels.defaults.glmModel` selects a literal model ID; omit it to let the
GLM wrapper choose. `OMC_EXTERNAL_MODELS_DEFAULT_GLM_MODEL` also overrides the model.
Fallback is disabled in V1; `fallback: true` is rejected. Missing GLM never silently
spends Claude quota.

A POSIX wrapper concept (install outside this repository):

```bash
#!/usr/bin/env bash
set -euo pipefail
export CLAUDE_CONFIG_DIR="$HOME/.claude-glm"
exec claude "$@"
```

Configure the GLM Coding Plan / Anthropic-compatible endpoint in that separate
Claude Code profile. Configure credentials outside OMC. OMC does not manage,
copy or serialize provider authentication. The wrapper must not print credentials.
Use an executable wrapper on Windows; `.cmd`, `.bat` and PowerShell scripts are
not accepted by this shell-free GLM launch path. POSIX shell wrappers work in
their native POSIX environment.

```text
omc doctor --team-routing
omc ask glm "inspect the authentication subsystem"
omc team 4:glm "implement the scoped assignments"
```

Ordinary `omc team` uses the existing team runtime and requires tmux/psmux.
GLM selection enables native named worktrees and refuses automatic merging.
The explicit workflow controller runs local processes without needing tmux.
If you have explicitly disabled runtime-v2, re-enable it for ordinary GLM teams
with `OMC_RUNTIME_V2=1`; legacy-v1 GLM launches fail before creating workers.
For all ownership, integration,
verification and review gates below, use `omc team workflow`.

## Routing and responsibilities

The profile expands the existing `team.roleRouting` configuration. Explicit
per-role overrides retain precedence.
The strict workflow resolves its executor and reviewer through that same router,
including model overrides. It requires a GLM executor and Codex code-reviewer;
conflicting provider overrides fail clearly at initialization. Ordinary team
commands continue to support the broader routing choices.

| Role | Provider |
| --- | --- |
| Lead/orchestrator | Claude |
| Planner, architect | Claude HIGH |
| Executor, debugger, test-engineer | GLM |
| Critic, code-reviewer | Codex |

Claude remains responsible for architecture decisions and final acceptance.
Keep approximately 0–2 concurrent Claude specialist subagents for difficult
architecture, dependency, security or debugging questions. This is guidance,
not a hard model limit. GLM handles routine implementation. Each assignment
starts a fresh process; persistent GLM sessions are not part of V1.

The workflow controller exposes operations for the Claude lead to invoke. It does
not start a second Claude lead or pretend that a deterministic program can decide
whether a review finding is valid.

## Prepare a scoped plan

Start from a clean Git checkout. Commit or ignore project configuration before
capturing the base with `git rev-parse HEAD`. The lead writes the JSON plan under
`.omc/plans/feature-x.json` before dispatch; keep this plan and subsequent decision
and fix files untracked or ignored. Untracked files under `.omc/` are allowed by
the workflow's clean-checkout check; a new untracked `plan.json` at the repository
root would block initialization.

Use the exact current commit SHA for every initial `baseCommit`; choose a new,
dedicated integration branch, never `main` or `master`. Run workflow commands from
the target project's root. A one-task illustration:

```json
{
  "name": "feature-x",
  "objective": "Implement feature X",
  "baseCommit": "REPLACE_WITH_FULL_GIT_COMMIT_SHA",
  "integrationBranch": "integration/feature-x",
  "tasks": [
    {
      "id": "backend",
      "objective": "Implement the backend contract",
      "baseCommit": "REPLACE_WITH_FULL_GIT_COMMIT_SHA",
      "writeScope": ["src/backend/**", "tests/backend/**"],
      "readScope": ["src/types/**"],
      "prohibitedScope": ["package.json", "src/frontend/**"],
      "dependencies": [],
      "contracts": ["Preserve the public request and response types"],
      "acceptanceCriteria": ["Backend tests cover success and invalid input"],
      "tests": [{"command": "npm", "args": ["test", "--", "backend"]}]
    }
  ],
  "verification": [
    {"command": "npm", "args": ["run", "test:run"]},
    {"command": "npm", "args": ["run", "build"]}
  ]
}
```

Add three or four independently owned tasks for parallel execution. Scopes are
relative literal files or directory prefixes ending in `/**`; arbitrary glob
syntax and traversal paths are rejected. Combine overlapping tasks or give them
explicit dependency ordering. Commands use executable/argument arrays; no shell
expansion takes place. On Windows, use directly executable commands, for example
`node` plus a script path instead of a shell-only npm shim.

```text
omc team workflow init --file .omc/plans/feature-x.json --workers 4
omc team workflow run feature-x
omc team workflow status feature-x
```

Worker counts are OMC admission limits, not claims about GLM subscription capacity.
Excess assignments remain queued. Retries and backoff are bounded; dirty or
ambiguous output needs lead inspection rather than destructive retry cleanup.

Each worker uses OMC's native named worktree and branch. Canonical workflow state
stays under the leader's OMC team root. Workers must commit their task, stay within
write ownership, preserve their assigned branch, and return a concise result.
GLM workers currently launch with `--dangerously-skip-permissions`, which bypasses
Claude Code's interactive permission prompts. Worktrees provide Git isolation,
not an operating-system security sandbox. Use a trusted local wrapper and
additional OS isolation if required by your environment.

## Accept and verify

The lead receives task outcome, commit, files, test results, interface changes,
assumptions, risks, summary and artifact references. Full stdout/stderr stay in
bounded artifacts and are never automatically included in normal status. Inspect
important diffs selectively before accepting commits.

```text
omc team workflow accept feature-x backend
omc team workflow reject feature-x unwanted-task --reason "Outside the agreed scope"
omc team workflow verify feature-x
```

Only accepted commits integrate. Workers do not merge into the integration branch
or main. Conflicts and dirty worktrees are preserved for lead inspection. A worker
claiming that tests passed is not a substitute for integrated local verification.
The controller runs the plan's deterministic verification and ties evidence to the
exact integration commit; changed code needs fresh verification.

## Independent review and bounded remediation

```text
omc team workflow review feature-x
```

Codex receives the base, integration commit, acceptance criteria and contracts,
without GLM transcripts. Its dedicated invocation requests a read-only sandbox
and structured findings; it does not use the ordinary ask command's permissive
execution mode. See the [official non-interactive Codex documentation](https://learn.chatgpt.com/docs/non-interactive-mode).

The Claude lead evaluates each finding and supplies decisions in a JSON array:

```json
[
  {"findingId": "REPLACE_WITH_P1_FINDING_ID", "disposition": "fix", "reason": "Confirmed incorrect result"},
  {"findingId": "REPLACE_WITH_P3_FINDING_ID", "disposition": "dismiss", "reason": "Style preference outside scope"}
]
```

```text
omc team workflow adjudicate feature-x --file .omc/plans/decisions.json
omc team workflow add-fix feature-x --file .omc/plans/fix.json
omc team workflow run feature-x
omc team workflow accept feature-x fix-backend
omc team workflow verify feature-x
omc team workflow review feature-x
omc team workflow finish feature-x
omc team workflow cleanup feature-x
```

`fix.json` contains `{ "task": <a complete scoped task>, "findingIds": ["..."] }`.
Use the current integration commit as the fix task's base. Valid P0/P1 findings
must be fixed; Claude decides material P2 findings, while P3 does not automatically
cause work. Dismissals require reasons. Claude may handle tiny high-context or
architecture-sensitive fixes through an explicit scoped task and acceptance path.

The default review budget is two passes: initial review and at most one re-review.
Set `--max-review-passes` at initialization to change it. A failed attempt still
consumes a review pass. The limit never converts unresolved findings into success.

After completion, explicit `cleanup` removes only clean, accepted worktrees through
OMC's existing safety checks. Rejected, dirty or changed worker worktrees remain
available for inspection. The workflow ledger and artifacts are retained.
Normal status is capped at 16 KiB; previews identify omitted tasks and reference
the complete state and result artifacts.

## Local verification and CI

Workers run scoped local tests and commit without automatically pushing or waiting
for remote CI. The lead integrates accepted work, runs broader local verification,
then pushes a coherent integration branch when authorized. Run remote CI at those
integration points, not automatically for each worker commit.

Recommended GitHub Actions configuration includes concurrency groups with
`cancel-in-progress`, relevant `paths`/`paths-ignore` filters, self-hosted runners
for routine checks, and a clean GitHub-hosted runner for final verification.
V1 does not rewrite workflow YAML, manage runners, call CI cancellation APIs or
schedule distributed jobs. Cheap deterministic checks precede AI review and CI.

## Troubleshooting

- **GLM unavailable:** inspect `omc doctor --team-routing`, PATH and executable
  permissions. Confirm the wrapper's separate profile works outside OMC.
- **Wrong model:** check `externalModels.defaults.glmModel`, role model overrides
  and the GLM model environment overrides. Omit overrides to inherit wrapper defaults.
- **Scope or branch rejected:** inspect the worker artifact and native worktree;
  repair or reject the task explicitly. Do not force-delete dirty worktrees.
- **Verification or review blocked:** ensure intended commits are accepted, the
  integration checkout is clean, local commands pass, and evidence matches HEAD.
- **Review budget exhausted:** inspect remaining findings; completion stays blocked.
  Do not restart a review loop merely to erase its history.
- **Interrupted worker:** inspect preserved state and worktree before recovery.
  One-shot V1 does not reconnect to a persistent model session. Timed-out or
  interrupted assignments are not automatically retried by a subsequent run;
  inspect their work and begin a new scoped workflow when safe.

See [the implementation audit](design/glm-workflow-v1.md) and the short
[V2 roadmap](GLM-WORKFLOW-V2.md) for extension points and deferred work.

## Credential-free demonstration

Run `npx vitest run src/team/__tests__/workflow.test.ts` after installing the locked
development dependencies. The fixture creates temporary Git repositories and
launches real local Node processes pretending to be GLM and Codex. It demonstrates
three workers, explicit acceptance, a P1 fix/P3 dismissal, one re-review, and safe
cleanup without Claude, GLM or OpenAI credentials.
