# Local workflow V1.1 implementation plan

V1.1 extends the personal Claude lead → isolated GLM workers → independent Codex review workflow. V1 remains available on `codex/glm-workflow-v1` at `3e51fcf70545c2bc3ee5a24a9f11844e8a294c57`. This work lives on `codex/glm-workflow-v1.1`.

## Scope and cleanup plan

- Preserve V1 behavior by default; opt in at initialization with `--mode balanced`.
- Reuse the current process runner, workflow lock, worktree manager, artifact guards and acceptance gates. Add no dependencies, alternative schedulers or worktree managers.
- Extract the worker prompt into a small builder only where needed for stable ordering: instructions and optional shared project context precede the complete current task. Include bounded accepted dependency handoffs, with references to their full artifacts. Never replace scope, contracts, tests or acceptance criteria with a summary.
- Add optional bounded `sharedContext` to plans. Bind a saved session to the full task, context, model, command, base and canonical worktree. Keep each task's worker identity and branch immutable.
- Collect structured provider terminal usage in balanced mode using Claude stream JSON and Codex JSONL. Parse incrementally beyond the log capture limit, validate counters, avoid counting assistant events twice, and label absent or incomplete measurements. Keep provider usage separate from billing claims.
- Persist bounded attempt records, including failed attempts and review attempts. Report measured usage coverage alongside acceptance, retries, verification and review outcomes.
- Provide explicit same-task `resume <name> <task-id> --expected-head <sha> --reason <text>`. Require lead authority, accepted dependencies, remaining attempt budget, unchanged session identity, preserved clean canonical worktree and HEAD at the task base. Resend the complete contract. Never resume another task's conversation, silently fall back to a fresh session, or modify dirty/committed failed work.
- Keep default model capability, process isolation, exact-commit validation, lead acceptance, deterministic verification and read-only review unchanged. Do not introduce automatic prompt truncation or model downgrades.

## Verification

Test real subprocess and Git fixtures for opt-in arguments, stable prefix/full contracts, accepted dependency context, explicit resume and every safety boundary. Test provider event accounting for absent/malformed fields, duplicate events, failed outcomes and terminal events after large output. Run the existing workflow/provider/CLI regression suites, lint, typecheck, build and diff checks. Independently review the resulting implementation, then address findings before committing and pushing.

Authenticated provider calls and real cost savings remain unverified without a user-run smoke test. Existing unrelated Windows suite failures remain documented in the validation report. Cross-task conversation forks, dynamic system-prompt CLI tuning, distributed scheduling and new providers are deferred.
