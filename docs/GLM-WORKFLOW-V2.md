# After local V1.1: remaining candidates

The current role-substitution candidate is documented in
[Workflow V1.2 setup](GLM-WORKFLOW-V1.2.md). This page remains a list of further
design candidates; its filename is not a schema-version-two configuration guide.

Local V1.1 implements opt-in stable shared context, accepted dependency handoffs,
CLI usage accounting and explicit same-task session continuation at a preserved
clean base. See the [guide](GLM-WORKFLOW.md#balanced-mode-v11) and
[implementation plan](design/glm-workflow-v1.1.md).

V1 remains unchanged. The following are future design
candidates, not supported configuration values or promised delivery dates.

| Candidate | Likely extension point |
| --- | --- |
| Cross-task GLM conversation forks and committed-work continuation | Extend V1.1's same-task pristine-worktree boundary only after verifying session directory semantics and history preservation. |
| Cache/context affinity scheduling | Queue admission using task scopes/contracts; keep ownership checks authoritative. |
| Larger versioned project context artifacts | Extend V1.1's bounded sharedContext using existing artifact descriptors. |
| Backend/frontend/tests/general specialists | Existing roleRouting plus task scope metadata; no additional provider registry. |
| Two-machine pods | Workflow ledger and accepted commit boundary; define transport and trust separately. |
| Global provider concurrency | Replace local admission limit with an account-scoped lease service. |
| Richer CI state | Extend verification evidence attached to the exact integration commit. |
| Self-hosted runner integration | Verification execution adapter; keep runner management outside worker dispatch. |
| MiniMax/Kimi workers | Existing CLI provider contract, health probe and model configuration. |

Persistent sessions must add explicit cancellation/recovery semantics before reuse.
Distributed work must preserve one integration authority and durable ownership.
Neither should weaken read-only review, dirty-worktree preservation, or review limits.
