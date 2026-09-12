# V2 candidates (not implemented)

V1 intentionally runs one local process per assignment. These are future design
candidates, not supported configuration values or promised delivery dates.

| Candidate | Likely extension point |
| --- | --- |
| Persistent GLM logical sessions | Provider launch contract and workflow process lifecycle; retain bounded completion metadata. |
| Cache/context affinity | Queue admission using task scopes/contracts; keep ownership checks authoritative. |
| Stable project context artifact | Existing artifact descriptors referenced by structured assignments. |
| Backend/frontend/tests/general specialists | Existing roleRouting plus task scope metadata; no additional provider registry. |
| Two-machine pods | Workflow ledger and accepted commit boundary; define transport and trust separately. |
| Global provider concurrency | Replace local admission limit with an account-scoped lease service. |
| Richer CI state | Extend verification evidence attached to the exact integration commit. |
| Self-hosted runner integration | Verification execution adapter; keep runner management outside worker dispatch. |
| MiniMax/Kimi workers | Existing CLI provider contract, health probe and model configuration. |

Persistent sessions must add explicit cancellation/recovery semantics before reuse.
Distributed work must preserve one integration authority and durable ownership.
Neither should weaken read-only review, dirty-worktree preservation, or review limits.
