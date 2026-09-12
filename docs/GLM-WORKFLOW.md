# Claude lead, GLM workers, Codex review

This opt-in workflow assigns planning and integration to the Claude Code lead, bulk
implementation to local GLM wrappers, and independent final review to Codex CLI.
Without this profile, normal OMC routing and provider defaults remain unchanged.

The default behavior is V1. [Balanced mode V1.1](#balanced-mode-v11) adds local
usage measurement, shared context and guarded same-task session continuation.

Start with the [README setup and first-run instructions](../README.md#glm-workflow-v1-fork-setup)
to build this fork, sign in the Claude lead, configure the separate GLM profile,
authenticate Codex and start orchestration. It includes provider smoke checks
and a ready-to-adapt lead prompt. This guide supplies the detailed plan and
command reference.

## Configure the local provider

Add the following to your OMC configuration (`.claude/omc.jsonc` in the project or
`~/.config/claude-omc/config.jsonc` for Linux/macOS/WSL users, respecting
`XDG_CONFIG_HOME`; `%APPDATA%/claude-omc/config.jsonc` for native Windows users):

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

Create the wrapper using the [README's complete GLM profile setup](../README.md#3-create-the-glm-profile-and-wrapper).
It selects a separate Claude Code profile while the normal Claude lead retains
Anthropic access. Keep provider settings out of shared project settings, which
apply to both profiles. Native Windows requires a directly executable wrapper;
the README's Bash example runs on Linux, macOS or WSL.

Complete the [Codex sign-in and model selection](../README.md#4-install-and-sign-in-to-codex)
before review. Set `externalModels.defaults.codexModel` to the model you verified;
OMC's explicit review model takes precedence over Codex's own default.

```text
omc doctor --team-routing
omc ask glm "inspect the authentication subsystem"
omc team 4:glm "implement the scoped assignments"
```

Ordinary `omc team` uses the existing team runtime and requires tmux/psmux.
GLM selection enables native named worktrees and refuses automatic merging.
Each team saves its configured GLM worker maximum, including teams that start
with only Claude workers. Recreate the team to apply a changed maximum. Older
teams without a saved maximum capture it from the leader's project configuration
when they first add GLM workers.
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

If a proposed fix is wrong, reject its task with a reason and add a replacement
using a new task ID, the current integration commit and the same unresolved
finding IDs. The replacement may own the rejected task's files; the rejected
commit and worktree remain available for inspection. Do not make the replacement
depend on the rejected task: rejection does not satisfy a dependency.

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

## Balanced mode V1.1

Build the `codex/glm-workflow-v1.1` checkout using the [README instructions](../README.md#v11-local-efficiency).
The remaining examples abbreviate its absolute CLI invocation as `omc`;
ensure that command points to the intended built checkout.

```text
omc team workflow init --file .omc/plans/feature-x.json --mode balanced --workers 4
omc team workflow run feature-x
omc team workflow usage feature-x
```

The optional plan field `sharedContext` is a bounded string, for example
`"sharedContext": "This project uses one API schema; keep public request types backward compatible."`.
Use stable project facts, not progress updates. Full task requirements remain in
every prompt. Accepted dependency handoffs provide bounded summaries and artifact
references; the worker must inspect source and current contracts whenever more
detail is needed. Rejected or unfinished handoffs are not shared as accepted work.

### Read usage honestly

Balanced mode requests structured terminal events from the CLIs. Claude final
`modelUsage`, when supplied, covers all reported models including nested agents;
fallback `usage` covers the main loop and is marked partial. Codex reports input
including cached input and output for the turn; an optional cache-write counter
is retained when provided. Provider failure, malformed data
or missing counters produces partial/unknown measurements, never invented zeros.
Each invocation is counted once, including failed work, explicit resumes and
failed review passes. A repeated session ID does not mean its totals are a
cumulative lifetime bill. See [Claude usage accounting](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
and [Codex structured output](https://learn.chatgpt.com/docs/non-interactive-mode#make-output-machine-readable).
The quality report's `retries` counts additional controller attempts; it does not
count every internal network retry made by a provider CLI. A temporary Codex
connection error followed by a successful terminal completion is accepted;
definitive failed turns still fail the review.

`usage` reports known totals with coverage for each field and separate quality
outcomes. Provider token counts are not a dollar estimate or a guarantee about
Z.AI subscription credits. Do not compare a partial GLM observation to complete
Codex accounting as if they measured identical work. Run comparable scoped tasks
from equivalent bases, keep model and tests fixed, and consider retries, accepted
commits and review findings before judging efficiency. There is no automatic
quality downgrade or automatic claim of savings.

### Continue a failed task deliberately

The lead first inspects the failure, logs and preserved worktree. A balanced
task can resume only when its prior provider session is confirmed, it is failed,
its worktree remains clean at the original task base, dependencies are accepted,
the saved execution identity is unchanged and an attempt remains. The integration
checkout must also be clean on its expected branch and commit. Obtain its full
current SHA with `git rev-parse HEAD`, then:

Session continuation also requires an explicit GLM model saved at initialization
through the existing role or `externalModels.defaults.glmModel` configuration.
Fresh balanced assignments may inherit wrapper defaults, but those implicit
defaults cannot establish a fixed model identity for resume. Configure the
intended model before initializing a workflow you may need to resume.

```text
omc team workflow resume feature-x backend --expected-head FULL_INTEGRATION_SHA --reason "Inspected transient failure; original worktree is clean"
```

Replace the SHA and reason with what you actually checked. This consumes one
attempt from the original budget and runs only that task with `--resume` and its
explicit UUID. It resends the full task contract and a new result path. A failed
resume remains visible; it does not silently switch to a fresh conversation.
The process itself is relaunched; conversation history lives in the same local
GLM Claude Code profile. Keep that profile's session files, provider settings
and wrapper intact. Do not pass `--no-session-persistence` in the wrapper.
The controller checks the saved task/context/model and executable identity plus
relevant launch environment fingerprints. It cannot discover every settings
file or credential source referenced internally by a custom wrapper; keep those
unchanged as well. Status `resumeCandidate` is a hint, not a replacement for the
resume command's full preflight checks.

Dirty or committed failed work cannot use this recovery shortcut. Inspect and
preserve that work, then plan a deliberate correction or replacement workflow.
Never edit workflow state, reset work or erase attempt history just to bypass a
guard. Session history is never moved to another task or worktree: Claude's
session lookup can restore the original worktree, and conversation forks do not
copy its filesystem. See [Claude session behavior](https://code.claude.com/docs/en/sessions).

### What remains unverified or deferred

Real authenticated provider runs and actual cache savings require a local smoke
test with your accounts. The implementation uses documented structured CLI
events; it does not set undocumented Z.AI cache controls. Stable application
prompts can improve prefix reuse, but provider-generated system context and
worktree paths still affect it. See [Claude caching](https://code.claude.com/docs/en/prompt-caching)
and [Z.AI caching](https://docs.z.ai/guides/capabilities/cache).

Cross-task conversation reuse, automatic specialization, cache-based scheduling,
dynamic system-prompt flag tuning and distributed/CI scheduling remain in the
[roadmap](GLM-WORKFLOW-V2.md). V1.1 preserves the V1 worktree, acceptance and review
gates. See the [validation report](GLM-WORKFLOW-VALIDATION.md) for tested limits.

## Credential-free demonstration

Run `npx vitest run src/team/__tests__/workflow.test.ts` after installing the locked
development dependencies. The fixture creates temporary Git repositories and
launches real local Node processes pretending to be GLM and Codex. It demonstrates
three workers, explicit acceptance, a P1 fix/P3 dismissal, one re-review, and safe
cleanup without Claude, GLM or OpenAI credentials.
