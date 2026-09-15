# Explicit workflow role substitution

Status: design and test packet, 2026-09-15. No implementation, provider switch,
saved-run migration or adoption is included. Source baseline:
`05fd3e4214207d9717cbcc1d83e948409df603a8`, branch `local/role-substitution`.

The founder requires Claude to review when Astra is unavailable, Claude to
implement when GLM is unavailable, and Astra to plan and integrate when Claude is
unavailable. Independent review is the preferred default, **not a requirement**.
Self-review is permitted when needed without another approval solely because the
author and reviewer match. Evidence must identify what actually happened.

This packet follows the lead's 2026-09-15 role-flexibility decision, sections 4 and
6C. Phase-one implementation waits for explicit adoption of the separate
review-path correction. That dependency's commit, built CLI hash and adoption
decision must be recorded before incorporating it here; it is not present in this
documentation commit. The reference checkout and every existing run remain intact.

## Scope and existing behavior

| Role | At the baseline | Phase one |
| --- | --- | --- |
| Lead | A caller invokes guarded CLI operations; OMC does not launch a Claude lead. | Record the actual external Claude or Astra lead and explicit handovers. |
| Implementer | GLM wrapper, owned worktree, structured handoff and controller test replay. | Add normal Claude through a distinct adapter/auth route. |
| Reviewer | Codex exec, read-only sandbox, structured findings and review-pass budget. | Add normal Claude with validated read-only tools and structured output. |

**Astra as external lead is already possible.** `assertLeadCaller` rejects
worker-marked callers, not non-Claude models; integration operations guard the
branch, head and worktree. No new Codex writing adapter is needed for Astra to
plan, invoke acceptance or adjudicate. Codex performing an implementation task is
a different, deferred adapter. GLM review is also outside this first packet; the
interface need not forbid a later validated adapter.

The controller does not prove an external caller's model or reasoning. Recording
the selected lead and the caller's evidence makes the provenance explicit; it does
not convert the deterministic controller into a reasoning authority.

Source references at the baseline:

| Source | Relevant behavior |
| --- | --- |
| [workflow.ts](../src/team/workflow.ts), lines 76–83, 390–405, 496–534 | Caller/source guards, explicit acceptance, disposition and finish. |
| [workflow.ts](../src/team/workflow.ts), lines 140–143, 253–257, 437–467 | Hard GLM-executor/Codex-reviewer check and operation-specific launches. |
| [workflow-routing.test.ts](../src/team/__tests__/workflow-routing.test.ts), lines 38–43 | Existing strict-profile rejection of Claude role overrides. |
| [stage-router.ts](../src/team/stage-router.ts), lines 189–239 | Generic orchestrator remains Claude; ordinary routing fallback is a different path. |
| [workflow-contracts.ts](../src/team/workflow-contracts.ts), lines 26–37, 68–115 | Provider-specific options and schema-version-one state. |
| [workflow-process.ts](../src/team/workflow-process.ts), lines 33–66 | Native child launch, inherited environment and nested-session marker removal. |
| [model-contract.ts](../src/team/model-contract.ts), lines 188–240 | GLM and Claude implementation contracts; Codex interactive contract is not exec review. |
| [workflow-report.ts](../src/team/workflow-report.ts), lines 15–18 | Accounting assumes every implementation invocation is GLM and review is Codex. |

The existing `team.roleRouting` seam can resolve provider/model choices, but the
strict workflow's rejection and launch contracts must change for a new profile.
Changing `glmCommand` to `claude` alone would leave wrong provider labels,
authentication assumptions and continuation semantics. Keep `team.glm.fallback`
equal to `false`; explicit substitution is a different operation, not that flag.

## One adapter seam, existing controller

Keep task scheduling, ownership, test replay, acceptance, finding disposition and
finish in the existing controller. Place an operation-specific adapter module at
`runWorkflowProvider` in `workflow.ts`. Its interface prepares and validates an
invocation; the shared process runner still owns spawning, cancellation, bounded
capture, redaction and artifact creation. Reuse existing utilities and add no
dependency merely to model these four concrete routes.

Separate these concepts in a saved binding:

| Field | Meaning |
| --- | --- |
| `role` | External lead, implementer or reviewer responsibility. |
| `providerRoute` | Normal Claude, isolated GLM or Codex; actual provider attribution. |
| `cliFamily` | Claude Code, Codex exec, or external caller for a lead. |
| `model` and optional `effort` | Explicit selected values, preserved without silent alias substitution. |
| `authProfileRef` | Nonsecret route identifier; private authentication material stays outside workflow state. |
| `executableIdentity` | Resolved executable/version/fingerprint used for this invocation. |
| `capabilities` | Validated operation/protocol/permission/continuation capabilities, with evidence/version. |

Capabilities describe executable behavior: structured handoff or findings,
required review restrictions, supported resume and bounded terminal events.
They do not prove model quality. Preserve the selected model's intended capability
and complete task context. Backend fitness tags in
[capabilities.ts](../src/team/capabilities.ts) are not protocol or security tests.

A conceptual interface, **not an implemented export**, is:

```ts
declare function prepareInvocation(
  binding: WorkflowBinding,
  operationContext: OperationContext
): PreparedInvocation;
```

The result supplies exact argv, a private child environment, input contract and
an operation-specific terminal/result decoder. Do not serialize that environment
into the public manifest. Public evidence contains the sanitized binding,
capability evidence, fingerprints and artifact descriptors. Decoding returns the
existing handoff/findings shape plus terminal status and truthful telemetry.

The controller must distinguish launch failure, provider failure, protocol
failure, test failure and successful validated completion. A process exit of zero
does not compensate for a missing or malformed result. Shared result validation
and the adopted path guard remain authoritative for every adapter.

The generic interactive Codex launch contract bypasses sandbox/approvals for its
separate use case. It must not replace the current read-only `codex exec` review
adapter. Similarly, a Claude implementation invocation with skipped interactive
permissions is not a reviewer adapter.

## Concrete Claude reviewer candidate

Local, non-authenticated inspection on 2026-09-15 ran only `claude --version` and
`claude --help`, both exiting zero. The installed executable reported **Claude
Code 2.1.258**. Its help advertises every flag below. This proves flag availability,
not their combined runtime behavior, authentication, filesystem confinement or
structured-result shape.

Proposed fresh-review argument array, with values supplied by the controller:

```js
[
  "--print", "--model", selectedModel,
  "--safe-mode", "--restricted",
  "--tools", "Read,Glob,Grep",
  "--permission-mode", "dontAsk",
  "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
  "--no-chrome", "--disable-slash-commands",
  "--no-session-persistence",
  "--output-format", "stream-json", "--verbose",
  "--json-schema", JSON.stringify(findingsSchema)
]
```

If selected, add the supported literal `--effort` value. Pass the bounded review
request through stdin and preserve the exact array in safe launch evidence.
Do not add `--fallback-model`, `--bg`, `--cloud`, unrestricted command tools or
permission bypass. `--bare` is not a universal auth-isolation replacement: this
version's help says it skips OAuth/keychain authentication and expects API-key or
other explicitly supported authentication.

The controller supplies the fixed base/head, required project instructions,
accepted criteria and a bounded source/diff inventory because safe mode disables
automatic project customization. The reviewer reads code through the listed
tools; it does not need Bash to obtain a controller-generated diff. Oversized
required context fails visibly or uses explicit bounded referenced artifacts;
it is never silently omitted. Tests are run by the controller, not by granting a
reviewer arbitrary command execution.

Claude has no advertised equivalent here to Codex's `--output-last-message` file
contract. The adapter must decode the actual structured terminal envelope from
the stream, then let the controller write its validated result artifact. Existing
Claude-shaped GLM usage parsing is reusable internally; provider attribution
remains normal Claude. A live, bounded check must establish the terminal and
structured-output fields before this adapter is called supported. Flags or a
synthetic imitation alone cannot establish that compatibility.

Managed policy can still affect the effective tools/settings. Effective read-only
behavior and normal-route authentication must be checked rather than inferred
from `--safe-mode` or prompt wording. Do not weaken the permission contract merely
to make a blocked configuration run.

## Authentication and model selection

Construct child environment/profile selection per binding. Normal Claude uses
the existing normal route; GLM keeps its separate wrapper/profile; Codex keeps
its own login. Do not carry GLM base URL, token or profile routing into normal
Claude, and do not rewrite global settings to choose a substitute. Remove nested
lead-session markers as today, but do not mistake that for profile separation.

Bind the launch to safe route/executable/settings fingerprints without putting
credentials, profile contents or private transcripts into state, prompts or logs.
Preserve the existing route distinction in `model-contract.ts:337`: when
`disableExternalLLM` is set, normal Claude remains eligible while GLM and Codex
are blocked. Apply that same explicit route check in the extended workflow
runner; do not accidentally block normal Claude because the old runner only
knew external providers, or let GLM evade the policy by adopting a Claude label.

Resolve selected model/effort once, record the actual values and refuse
unsupported combinations before dispatch. A CLI's default, automatic fallback or
successful generic capability score is not permission to lower model capability.
Usage with missing fields remains partial or unknown, never zero cost. Group
reports by actual recorded routes and invocations rather than deriving provider
counts from task versus review counters.

## Review relation and role handover

The review manifest records author identity when known, reviewer identity,
session/context relationship and `independent`, `self-review` or `unknown`.
These are provenance statements, not a quality score or an extra approval gate.
The controller records runner-supplied evidence; it does not accept a model's
unsupported declaration of independence.

Prefer a fresh reviewer context. Phase one can use fresh review invocations while
allowing the same agent/provider that authored the change to review it; this is
still self-review. Same-session review may be supported only when its adapter
demonstrates an effective role/permission transition and compatible context. Its
absence does not prohibit self-review through a fresh invocation. Never reject
solely because author and reviewer match. A lead accepting someone else's commit
is not, by that fact alone, the code author; record the actual relationship.

An external lead handover records prior/new actor, provider/model where known,
reason, expected integration head and decision reference. Astra uses the same
guarded lead CLI operations as Claude. Preserve who authored, reviewed and
adjudicated each result; a role replacement must not retroactively relabel it.

Long controllers remain owned by the monitored host, outside a short-lived
headless lead process. Provider/lead substitution does not change this operational
lifetime requirement or authorize detached background recovery loops.

## Explicit substitution and durable state

Use a separately versioned new state/profile, proposed `schemaVersion: 2` and
`profile: "role-substitution"`. Exact new CLI/config spellings are implementation
work; none shown here is an available command. The new interface must support:

1. Declaring role bindings at initialization with the existing full plan/checks.
2. Explicitly substituting a role before a future invocation with a reason and
   expected current head, while holding the existing workflow lock.
3. Inspecting the selected bindings, substitution history, actual review relation
   and remaining budgets without launching a provider.

Save an immutable binding snapshot on each invocation/review attempt. Append a
substitution record with old/new binding, role/task/pass, observed availability
failure or other declared reason, UTC, source/worktree/head and authority/policy
reference. This uses existing atomic state and canonical task projections; no new
event broker is needed. Never edit historical records to make an old invocation
look as though it used the replacement provider.

A substitution is a distinct, logged selection, not an automatic catch-all retry.
The founder has authorized this policy; do not require another founder approval
solely for substitution or self-review. Preserve the failed availability check or
operation. Test failures, invalid handoffs, path/schema mismatches, scope breaches
and unadjudicated findings must not be classified as provider unavailability.
Unknown failure cause stays unknown until inspected.

Record whether a failure happened during preflight, after reserving the operation
attempt/pass, or after spawning the provider. Selecting a route or discovering a
missing executable before reservation does not invent a provider invocation;
preserve that diagnostic separately. A replacement launch reserves the next
existing task attempt or review pass before it starts, and a reserved failed
attempt stays consumed even if launch fails. No replacement resets counters,
increases maximums, bypasses
exhaustion or drops a failed attempt. A pristine-worktree same-provider retry
already permitted by V1 is distinct from new cross-provider substitution.

Changing the provider creates a fresh invocation identity. Balanced resume still
requires a confirmed compatible session and unchanged binding, selected model,
auth/executable identity, task contract, worktree/branch/base and role context.
Never send a GLM session ID to normal Claude or Codex. Preserve partial/committed
work, failed artifacts and interrupted running state; do not automatically
resume, clear a lock or overwrite a result to enable substitution. An active
controller precludes a concurrent binding change.

The minimal rollout need not migrate V1 saved runs. New runs may use new bindings;
V1/V1.1 continues through its exact legacy defaults and load guards. A separately
identified replacement workflow, if needed, carries predecessor/evidence and
logical consumed-budget references; it cannot be used to erase a previous run or
retry limit. A future migration needs explicit recorded adoption and dedicated
compatibility tests, not opportunistic JSON edits.

## Implementation sequence and acceptance

1. **Dependency first:** identify the adopted review-path correction and its
   runtime/contract hashes. Incorporate it explicitly on this branch without
   rewriting the original baseline or preserved runs. Keep its path validation
   regression. The current absolute-path failure is not provider unavailability.
2. **New contract and adapters:** add the versioned bindings and operation adapter
   seam; preserve legacy defaults. Implement normal Claude worker/reviewer, with
   authenticated route separation and truthful external-lead/review provenance.
3. **Observable workflow behavior:** exercise public init/run/accept/verify/review/
   adjudicate/finish interfaces with real synthetic child processes, including
   failure, permission, budget and continuation cases in the
   [test plan](ROLE-SUBSTITUTION-TEST-PLAN.md).
4. **Separate live compatibility evidence:** bounded synthetic-source tasks with
   selected authenticated providers establish actual Claude flag combinations,
   terminal formats and capability behavior. Do not induce real quota exhaustion.
   No such call is part of this design packet.
5. **Adoption:** report commit, source/build/contract hashes, actual tests, live
   limitations, review relation and compatibility evidence to the lead. A changed
   compiled contract hash also needs explicit adoption by pinned consumers such
   as Shello's handoff helper. Do not silently substitute the new binary for old
   runners. Main/publication/deployment gates are separate.

Planned implementation touches the workflow/config/contracts, provider-process
and reporting modules needed for these behaviors; the exact owned paths must be
assigned after the dependency is adopted. This packet changes documentation only.
It does not authorize Codex implementation, additional provider families, global
profile rewrites, automatic model fallback, distributed scheduling or session
history copying.

## Packet evidence and limits

Source reading and local CLI version/help inspection were performed. No build,
source test, synthetic process test, authenticated compatibility check or live
workflow was run for this packet. The test plan contains expected observations,
not passing results.

Local authority/evidence captures used when preparing this portable design:

| Capture | SHA256 |
| --- | --- |
| `lead-role-flexibility-decision.md` | `78634bcb0e5a449e8051b88ce63c8b4486e063b5e841c6a82160cb761b4ec7b7` |
| `founder-role-flexibility-requirements.md` | `60ab3dc656e04142baf869d2f141b1323c680fd0cf0c6afb11d8326358a566a9` |
| `omc-role-flexibility-assessment.md` | `18ca5fd72253448d6424ef338a628bf1f64aac0ce07697a425c2dd8c80ba0f7b` |

The first capture groups Codex lead and execution as deferred. This design makes
the source-backed distinction above: external Astra lead already works through
caller guards; a Codex implementation adapter is deferred. Its broader GLM-review
suggestion is also outside the first Claude worker/reviewer scope assigned here.
