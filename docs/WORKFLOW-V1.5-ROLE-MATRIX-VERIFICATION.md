# Workflow V1.5 lead/worker/reviewer matrix verification

This record covers the live role matrix the maintainer required before `workflow-v1.5`: every combination of a Claude Code or Codex native lead, a GLM `glm-5.3` or `glm-5.3-flash` implementer, and a Claude or Codex reviewer, run through the role-substitution profile on the release candidate. It distinguishes what the authenticated runs proved from what remains synthetic. No credential value, raw provider output, header or query string is reproduced here; sanitized evidence stays in the ignored local `.tmp-v142-evidence/claude-live/matrix/` directory of the working checkout.

## Source identity and environment

- Runtime under test: the release-candidate source `3d2070c7c` (the upstream 5.5.0 merge plus the recovery fix and its rebuilt shipping closure), built locally on Windows with Node 24.18.1. The commits after it on the release branch change only documentation and the inventory baseline.
- Native hosts: Claude Code 2.1.272 signed in through the existing default profile on a Max subscription, and Codex CLI 0.155.0-alpha.9.2 from its own secure store. No global settings were edited and no credential was copied.
- Models: Claude lead and Claude reviewer `sonnet` (observed `claude-sonnet-5`); Codex lead and Codex reviewer `gpt-5.6-sol` at low reasoning effort, chosen by the maintainer to conserve Codex credit (`gpt-6-astra` and `gpt-5.6-luna` are one-line switches in the lane helper); GLM implementer exactly `glm-5.3` or `glm-5.3-flash` through the existing `claude-glm` private profile and the configured sanlangcode gateway.
- Bindings: each lane recorded executable identity (path, SHA-256, version), a private authentication-profile fingerprint and `validation: 'authenticated'` capability evidence produced by a bounded live marker probe for the implementer and the reviewer, then initialized a schema-2 role-substitution workflow with one task, one worker, one attempt, one review pass, a ten-minute provider timeout and the supervised provider policy.
- Every lane used a disposable repository under a short temporary path, a private `OMC_STATE_DIR`, and an environment with the desktop session's `CLAUDECODE`, `CLAUDE_CODE_*`, `ANTHROPIC_BASE_URL` and OAuth override variables removed. The Claude lead was launched with `omc launch -p ... --output-format stream-json --allowedTools Bash`; the Codex lead with `omc launch exec ... --ephemeral --ignore-user-config`.

## Lane definition

Each lane asked the native lead to run, once and in order: `orchestrator status --json`, `team workflow run` with the runtime profile, `team workflow status`, an independent worker-inspection script, `team workflow accept <task> provider`, `team workflow verify`, `team workflow review` with the runtime profile, `team workflow status`, and, only if verification passed with an empty findings array, `team workflow finish` and a final status. The lead then replied with a lane-specific marker. A lane passes only when the lead process exited cleanly with the exact success marker, every expected command succeeded, no environment secret or credential indicator appeared in the captured output, the lease was released with the expected host still active, and the shared state shows stage `complete`, task `accepted` on the first attempt, verification passed, one review pass with zero findings, the implementer invocation on the GLM route under the expected host, and the review on the expected reviewer route. A credential-free postflight then switched the host away and back and confirmed byte-stable state.

## Results

| Lead   | Worker        | Reviewer | Result | Lead model      | Reviewer model | Final state                     | Lead time |
| ------ | ------------- | -------- | ------ | --------------- | -------------- | ------------------------------- | --------- |
| Claude | glm-5.3       | Claude   | passed | claude-sonnet-5 | sonnet         | complete / accepted, 0 findings | 198 s     |
| Claude | glm-5.3-flash | Claude   | passed | claude-sonnet-5 | sonnet         | complete / accepted, 0 findings | 151 s     |
| Claude | glm-5.3       | Codex    | passed | claude-sonnet-5 | gpt-5.6-sol    | complete / accepted, 0 findings | 214 s     |
| Claude | glm-5.3-flash | Codex    | passed | claude-sonnet-5 | gpt-5.6-sol    | complete / accepted, 0 findings | 190 s     |
| Codex  | glm-5.3       | Claude   | passed | gpt-5.6-sol     | sonnet         | complete / accepted, 0 findings | 409 s     |
| Codex  | glm-5.3-flash | Claude   | passed | gpt-5.6-sol     | sonnet         | complete / accepted, 0 findings | 375 s     |
| Codex  | glm-5.3       | Codex    | passed | gpt-5.6-sol     | gpt-5.6-sol    | complete / accepted, 0 findings | 440 s     |
| Codex  | glm-5.3-flash | Codex    | passed | gpt-5.6-sol     | gpt-5.6-sol    | complete / accepted, 0 findings | 406 s     |

All eight lanes passed the full gate, including the postflight host switch, with zero secret or credential-indicator matches in any captured output. The four Codex-led lanes passed on their first run. Claude lead sessions cost between USD 0.30 and 0.38 each; Codex lead sessions used about 400k input tokens (roughly 350k served from cache) and about 2k output tokens each.

## Attempts that did not count, and why

The four Claude-led lanes needed reruns before they passed. None of the failed attempts reached a product defect, and no attempt was retried inside a workflow; each rerun was a fresh disposable fixture.

- Preparation, first run: the lane helper recorded the executable version as `2.1.272 (Claude Code)`, which the binding literal validator rejects; the helper now keeps the version-number token. No provider call was made.
- Claude reviewer, two attempts each: the workflow reached adjudication with verification passed, but the Sonnet reviewer returned one informational P3 finding saying the "declared Node check" could not be verified from repository contents (the check is a `node -e` command in the plan, not a file). The Claude lead correctly stopped before `finish` as instructed. The fixture plan now states repo-verifiable acceptance criteria; the controller behaved as designed.
- Claude lead with Codex reviewer, first attempt: the `glm-5.3` worker ran the declared test but reported it without the `-e` argument, so the controller refused the handoff with `workflow_worker_test_evidence_missing` before any reviewer call. This is the fail-closed test-evidence rule working; the worker slip did not recur.
- Claude lead with Codex reviewer, three attempts: the Sonnet lead declined to execute the scripted lane, citing the prompt's instructions not to investigate or inspect. Rewriting the lead prompt as plain instructions that invite orientation and explain why a single unmodified run is needed resolved it. This is a lead-prompt matter, not a controller behaviour.

## What this proves and what it does not

- Claude Code and Codex each drive the whole role-substitution workflow as the native lead, with the implementer on the exact requested GLM model and the reviewer on either native route, and the lease is released cleanly at the end.
- The authenticated Claude reviewer path, which the [Claude lead record](WORKFLOW-V1.4-CLAUDE-LEAD-VERIFICATION.md) left to synthetic regressions, is now live-validated for both worker models and both leads.
- Flash assistant completion events identify Flash; effective million-token capacity and `[1m]` routing were not exercised here. The recovery fix itself was validated by regressions and the earlier crash evidence, not by a deliberate crash in these lanes.
- Native hook execution was observed for Claude lanes and remained unobserved (advisory, untrusted) for Codex lanes; core workflow gates were authoritative in every lane.
- Codex ran at low reasoning effort on `gpt-5.6-sol`; other Codex models and efforts, remediation loops beyond one attempt, and multi-task plans were not part of this matrix.
