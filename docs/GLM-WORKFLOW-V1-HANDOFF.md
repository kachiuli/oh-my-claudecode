# Prompt for using V1 in another project

Copy the text below into the Claude Code task for the project you want to change.

```text
We can use my personal OMC V1 fork for a controlled trial in this project.
Please assess whether it fits this project, then use it for suitable scoped work.

Repository: https://github.com/kachiuli/oh-my-claudecode
V1 branch: https://github.com/kachiuli/oh-my-claudecode/tree/codex/glm-workflow-v1
Reference commit: 3e51fcf70545c2bc3ee5a24a9f11844e8a294c57
Setup README: https://github.com/kachiuli/oh-my-claudecode/blob/3e51fcf70545c2bc3ee5a24a9f11844e8a294c57/README.md#glm-workflow-v1-fork-setup
Workflow guide: https://github.com/kachiuli/oh-my-claudecode/blob/3e51fcf70545c2bc3ee5a24a9f11844e8a294c57/docs/GLM-WORKFLOW.md
Validation report: https://github.com/kachiuli/oh-my-claudecode/blob/3e51fcf70545c2bc3ee5a24a9f11844e8a294c57/docs/GLM-WORKFLOW-VALIDATION.md

Use that V1 reference while the local-efficiency V1.1 work is developed separately.
This is a source checkout: build it before use and invoke its CLI by absolute
path from this project's working directory. Installing upstream OMC alone does
not install this fork's workflow.

The intended workflow is:
Claude leads planning and integration → 3–4 GLM workers in separate worktrees →
concise handoffs → Claude accepts selected commits and runs local checks →
Codex independently reviews read-only → Claude evaluates findings → GLM fixes
valid findings → at most one additional review by default.

Before using it, inspect this project and tell me:
1. Whether Git/worktrees, the project structure and our current changes permit
   a small isolated trial. Preserve current work and use a separate project clone.
2. Whether Claude, the separate claude-glm profile/wrapper, Codex and this fork
   are available in the same environment. For the documented Windows walkthrough,
   use WSL2; native Windows needs a directly executable GLM wrapper.
3. Whether authentication and selected model IDs work. Keep Claude as the lead
   on its normal connection. Keep GLM credentials out of project settings,
   source, prompts and reports. Report any sign-in step I must complete myself.
4. Which tasks can have separate write ownership, which need dependencies,
   and which architectural decisions should stay with the Claude lead.
5. Which dependency setup, ignored files, test fixtures and executable checks
   each fresh worktree needs. Choose meaningful integrated tests/typechecks/builds.
6. Any blockers or limitations that make this project unsuitable for the trial.

V1 has passing targeted tests and independent reviews, but authenticated provider
execution has not been validated end-to-end and broader Windows suite failures
remain. Do not describe it as fully release-verified. It bounds handoffs and
review cycles; it does not promise measured cache savings or persistent workers.

When using it, use omc team workflow and follow the plan/accept/verify/review
gates. Treat worker success as a claim to verify. Keep important context,
contracts and tests; do not weaken reasoning or review just to reduce tokens.
Do not merge into main or push worker changes automatically.

If a bug occurs:
- Preserve the worktrees, commits, .omc state and relevant logs. Avoid destructive
  cleanup and repeated blind retries. Interrupted V1 workers do not reconnect.
- Determine whether it is a project-code bug, OMC controller bug, provider/auth/
  model problem, or an environment/upstream issue. Reproduce with the smallest
  safe example and identify the first failing operation.
- Report the fork commit, OS, CLI versions, exact command, workflow/task IDs,
  expected and actual behavior, relevant test results and redacted artifact
  excerpts. Never paste credentials or full private transcripts.
- For a project bug, use a scoped correction with tests and explicit acceptance.
  For an OMC bug, prepare a reproducible report for the fork; keep any proposed
  fix separate from this project's feature changes. Do not publish reports
  containing project information without my authorization.
- Verify the correction with a regression test and relevant project checks
  before resuming. If it cannot be resolved safely, report the blocker and keep
  the preserved work available for manual recovery.

Start by giving me a concise readiness assessment, the concrete checks you made,
and a small first task suitable for this project's current goal.
```
