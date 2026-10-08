# Workflow v1.6.4 handoff — 2026-10-08

Resume the existing correction and release effort for fork issues [#60](https://github.com/kachiuli/oh-my-claudecode/issues/60), [#62](https://github.com/kachiuli/oh-my-claudecode/issues/62), and [#64](https://github.com/kachiuli/oh-my-claudecode/issues/64). The user requested this remote handoff so another agent can pick up. No merge, release, consumer operation, or new model run was performed for this handoff.

## Exact pickup state

- Existing [PR63](https://github.com/kachiuli/oh-my-claudecode/pull/63) and [PR65](https://github.com/kachiuli/oh-my-claudecode/pull/65) remain open drafts. PR63 head: `f2d7aa98dafcc57856d1cc85bca7bfa753df111a`; PR65 head: `a0410ba7217c1783e042312b5a0207a97b925fbf`.
- Accepted PR65 source tree: `36d89f72e33253149c45187870879fde78eac3e0`. Its [exact-head CI](https://github.com/kachiuli/oh-my-claudecode/actions/runs/37704967873) passed all 22 normal checks, including 16,150 main-suite tests and 1,442 Windows-host tests. Its build capture passed. These results apply to that accepted source, not to the new candidate.
- New correction commit: `a7f448a25f079b9d00a98c8da67219fedb0ec40d`; tree `a83cd4d88904946b008e32ab0399a5b07ea01555`; sole parent `a0410ba7217c1783e042312b5a0207a97b925fbf`. This is a locally verified candidate, not a genuinely accepted Source11 result.
- Six local checks passed on that candidate: 30 focused tests, lint, TypeScript, static path analysis, inventory verification, and diff checks. Independent candidate review: **APPROVE, zero findings**. No unchanged tests were repeated for this handoff.
- Source11 administration exists locally as `w11` / workflow `omc60-order-20261008` / task `final-src`. Its packet remains **UNBOUND**. No Source11 workflow initialization, reservation, helper run, publication, acceptance, or native qualification/review occurred.
- No processes or model runs remain active from this handoff. Package/plugin versions stay **5.5.0**. Intended custom release: **workflow-v1.6.4**. Do not publish npm or an upstream `v*` tag.

This branch contains the candidate code commit and a separate documentation/evidence commit. Use the exact candidate commit/tree for source integration; do not treat the handoff documentation commit as the reviewed release tree or merge this handoff branch directly as an accepted result.

## Why the last full review failed

The stock native process completed successfully with exit 0. Its observer was healthy and handled four qualified disconnects as zero-credit abandonments followed by authenticated reconnects. Disposal left zero tracked resources.

Final coverage proof rejected receipt 4: the model read `objective`, while the verifier expected `instr-0` / AGENTS.md. The issued full-review descriptor did not specify the canonical manifest order, although calibration did. Only the manifest was admitted by reconstruction; serving all intended source bytes did not establish complete review. A separate, later count discrepancy was not reached by verification: the model reported 1,112 ranges versus 1,111 successful positive-page receipts. Zero reported findings were not accepted. PR63's complete review is still pending.

## The frozen four-file correction

- `src/team/workflow.ts`: explicitly requires manifest order and, for native review, copying the final trusted `progress.ranges` into the existing attestation.
- `src/team/workflow-review-source-server.ts`: private bounded progress names the next kind/id/cursor and exact successful positive-page count. Wrong-order/gap/overlap reads receive a correctable refusal before receipt or source credit. Literal-call replay independently recomputes the exact response/progress/refusal.
- `src/team/__tests__/workflow-native-review.test.ts`: one actual-handler regression covers objective-first refusal, canonical continuation, positive revisits, empty pages, progress through automatic compaction, bounded replies, intended/observed agreement, and rejection of count+1. Existing affected cases remain exercised.
- `inventory/inventory-graph.json`: required digest refresh.

The `WorkflowReviewCoverageMachine` and final observed-byte proof remain unchanged. Progress is serving advice, never admitted delivery authority. Positive successful revisits add one; empty pages/refusals add zero. Current-prefix revisits must end at or before the current frontier. Envelope previews must be pure and commit exactly once. The tracker uses bounded manifest iteration, ordinal counters and singleton bits; no growing collection, extra reconstruction, dependency, tool/input schema, bypass flag, profile tuning, or arbitrary-order proof rewrite was added.

## Preserve attempts and evidence

Ten source attempts were spent: six accepted and four failed. One additional source attempt is authorized, for cumulative total **11**, with a new workflow maximum of **one**. Do not reset, relabel, delete, or reuse prior attempt outcomes.

Full native reviews: **4 of 10 spent, zero completed**. A new workflow must carry four outside failures and start at local zero; at most six review passes remain. This handoff authorizes no blind retry. Each fresh review requires accepted source, current CI, fresh capture, actual qualification, same-live-factory adoption, and strict final proof.

Preserved host-local evidence lives under the managed worktree's `.tmp/omc-lane/release-gates-20261006/`; credentials, native histories, private captures, publisher authority, and full local artifacts are intentionally not committed. Useful directories are:

- `native-order-progress-correction-01`, `native-order-progress-evidence-01`, `native-order-progress-review-01`;
- `workflow-native-order-progress-packet` and `w11`;
- `workflow-native-reconnect-native-audit-01`, `workflow-native-reconnect-source-audit-01`, `workflow-native-reconnect-packet`;
- `release-preparation` and `ROOT-RELEASE-STATUS-09.json`.

See [workflow-v1.6.4-handoff-evidence.json](workflow-v1.6.4-handoff-evidence.json) for the candidate, check, review, plan, failure, controller and helper pins. Hashes identify evidence; serialized evidence does not transfer live native-factory or publication authority.

## Next authorized steps

1. **Finish binding Source11.** Bind the exact candidate files/patch/tree and six command vector; actual working-directory Vitest config/private cache; new workflow/worker/publisher identity; role bindings; current quiescence and host bytes. Validate the original helper against the **whole canonical issued task**, the original task parser and controller plan parser, operator syntax, dry application, and exact tree in a private Git index. Independently review and seal the READY packet before executing it. Existing fail-closed unbound skeletons are not executable acceptance authority.
2. **Run one genuine GLM5.3 source attempt.** Reuse the preserved original helper/check guard and protected foreground publisher route. The helper runs once with its five flags and the unchanged issued task. Preserve the raw result, inherited seven authority fields, child-check exits, errors, and actual settlement. Run owning-controller replay, supported acceptance and verification. Do not invent an overall helper exit or capability identity if it was not observed. Source controller `697b1fb6eebe6186736d83fa415151c7aa8dd4ba` is deliberately distinct from the actual task base `a0410ba...`.
3. **Push the genuinely accepted source to PR65**, through a normal non-force push. Require fresh exact-head CI and fresh accepted build/capture. Do not reuse the old head's CI/capture as proof for the new tree.
4. **Complete native qualification and review.** Use the qualified stock runtime/model/effort (Codex 0.159.1, Sol6.1-ultra; native effort xhigh), genuine qualification followed by adoption and complete review in the same live factory. Re-derive the mandatory-plus-changed whole-file corpus and PR63 lineage. The previous corpus had 84 source files and 95 logical entries; those numbers must be freshly derived, not hardcoded. No source/history/corpus truncation or proof substitution. Keep narrow disconnect and malformed-cursor rules; unknown/partial-output/unsupported transport failures stay fatal. Require exact count, all bytes, current history, compaction/reconnect joins, final findings disposition, EOF, process settlement and disposal.
5. **Finish and merge PR63, then PR65**, after accepted complete review and no unresolved findings. Rewrite final PR descriptions with the actual implementation/results; mark ready; use normal merges with exact-head matching. Final main tree must equal the fully reviewed implementation tree. Do not bypass branch protection or alter others' checkouts.
6. **Release after final-main CI.** Use an isolated clone, existing archive boundary utilities, actual archive hashes, package/build evidence, isolated installation smoke, and the prepared public administrative compatibility ZIP. Create an annotated `workflow-v1.6.4` tag at the exact final main commit, publish GitHub assets, download every asset and verify hashes. Only then close resolved #60/#62/#64. No consumer installation/recovery/adoption is needed or authorized as a release prerequisite.

User priority: finish essential work, keep small diffs, reuse utilities, add no dependencies, and avoid speculative test matrices. The passing 100,001-file stress case remains opt-in (`OMC_WORKFLOW_REVIEW_100K_STRESS=1`); do not rerun it as a normal gate. Required changed-code checks and the complete review remain necessary.

## Release preparation and material limits

The reviewed local packaging helper is `release-preparation/workflow-v164-artifacts.mjs` (pin in evidence JSON). It was prepared, not executed. It must run only after the final-main CI gate on a clean final-main source, using a fresh owned output directory and isolated dependency/cache/install state. Planned payloads: package tgz, public archive/build smoke evidence, public compatibility ZIP, and SHA256SUMS. Private original ZIP and diagnostic/cache/install artifacts must not be uploaded.

The public compatibility ZIP preserves original workflow-v1.6.2 contracts/process bytes and qualified administrative/native lease evidence. It does not transfer a live native capability or authorize consumer mutation.

The package is built on Windows. Check actual archive contents before platform claims: macOS graph persistence requires same-source Darwin addons. The currently inspected CI supplied only a `dist` artifact, not Darwin addon artifacts. If addons are absent, document the graph limitation; other commands do not load that addon. Installation smoke with dependency scripts disabled does not establish native dependency compilation.

No release is published, and all three issues remain open at handoff. Resume from these explicit gates; do not claim the earlier successful native process was an accepted full review.
