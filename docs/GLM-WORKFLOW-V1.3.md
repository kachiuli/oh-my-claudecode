# Workflow V1.3: one optional supervised provider policy

Status: local candidate with passing focused checks. V1.3 adds a single opt-in
initialization policy to both existing profiles; it is not a published release
and it does not migrate, upgrade or repair any earlier saved run. The
[V1/V1.1 guide](GLM-WORKFLOW.md), the
[V1.2 role-substitution setup](GLM-WORKFLOW-V1.2.md) and their
[validation status](GLM-WORKFLOW-V1.2-VALIDATION.md) remain accurate for the
workflows they already describe.

V1.3 is opt-in per workflow. A new workflow is supervised only when its lead
initializes it that way; every other workflow keeps the finite provider timeout
it saved before, byte for byte.

## What the policy changes

The saved policy has exactly two observable values in status output:
`supervised` when initialization selected it, and `legacy` when it was omitted.

Under `supervised`, the controller passes `timeoutMs: null` to the implementer
and reviewer provider calls only. `null` is the single explicit no-wall value the
process layer accepts: the provider still runs as a real child with its own
pipes, but the controller no longer terminates it because a configured number of
milliseconds elapsed. Everything else about a provider call is unchanged,
including argument construction, session handling, redaction, artifact
retention, commit validation and protected-ref checks.

The policy is never inferred. A provider name, model, CLI family, private
profile, environment variable, saved timeout value or observed duration never
selects it; only an explicit initialization value does. Omitting the policy
saves no value at all and keeps the legacy finite timeout.

Worker-declared test commands and integrated verification stay finite. They keep
receiving the saved numeric `timeoutMs` even under `supervised`, so a local check
that hangs still fails at the bound the lead chose. Git operations, help output,
upstream OMC waits and every other controller path are untouched.

## What supervised does not prove

An unbounded provider is not a monitored one. Because the controller no longer
stops a provider on elapsed time:

- output proves only that a process wrote bytes, and silence proves nothing at
  all. Neither a long quiet period nor a sudden burst is progress, completion or
  failure. The controller adds no idle timer, controller timer, observation
  callback, IPC channel, stop command or consumer-specific provider label to
  pretend otherwise.
- the explicit stop path is the host signal. Send `SIGINT` or `SIGTERM` to the
  running controller when a supervised provider must be stopped. The retained
  state then shows the unfinished attempt, and a later `run` refuses to
  re-spawn retained running work without explicit inspection.
- cleanup can remain unverified. A supervised provider that ignores the signal,
  or a descendant that keeps an inherited pipe open, can leave a worktree, a
  process or an artifact directory in a state the controller never observed.
  Preserve the state directory and the retained worker worktree for inspection
  rather than assuming cleanup finished.
- a provider that ends without a complete, parseable stream is not retried.
  `workflow_output_incomplete` is terminal, exactly like `workflow_timeout` and
  `workflow_interrupted`: the attempt, its invocation record and its process
  artifacts stay inspectable, and remaining attempt budget is not spent on an
  automatic second dispatch.

## Initialize a supervised workflow

`--provider-policy supervised` is accepted by `init` only. It applies to both
`claude-glm-codex` (schema 1, including balanced mode) and `role-substitution`
(schema 2, always balanced). Every other present value, a missing value and a
duplicate flag fail before any state directory, branch or provider exists, and
every later operation rejects the flag as an unknown option.

```text
node bridge/cli.cjs team workflow init --file plan.json --mode balanced --provider-policy supervised
node bridge/cli.cjs team workflow init --file plan.json --profile role-substitution \
  --bindings roles.json --provider-policy supervised
```

`--timeout-ms` keeps its own meaning and range (100 to 3600000 ms, inclusive).
Combining both is expected: the saved timeout is the bound for local checks and
verification, while the policy decides whether provider calls have a bound at
all.

```text
node bridge/cli.cjs team workflow status <name>
```

Status reports `providerPolicy` as `supervised` or `legacy` together with the
saved actors, bindings, substitutions, sessions, invocation evidence, review
provenance, attempt budgets and worktrees. It exposes no private runtime
configuration, environment value, process handle or transcript.

## Inspect the saved policy before dispatch

The saved policy is part of initialization, not a runtime switch. Loading
validates any present value in both schemas and refuses anything other than
`supervised` with `workflow_invalid_policy`, before a lock, a provider launch or
any work. A workflow whose state omits the field stays omitted: it is never
added, rewritten or migrated on read. The selected policy also cannot change
after initialization, so no substitution, resume, adjudication or other
transition can edit it.

Practical checks for a lead who is about to dispatch:

```text
node bridge/cli.cjs team workflow status <name>
node bridge/cli.cjs team workflow usage <name>
```

Confirm that `providerPolicy` is the value you intended, that the task actors and
attempt budgets are the ones you planned, and that the integration head is the
commit you expect. Do not infer the policy from a provider name or from how long
an earlier attempt took.

## No migration for earlier runs

Old saved workflows, old runners and old shell or script wrappers are left
exactly as they are. Nothing in V1.3 upgrades a schema-1 or schema-2 state file,
rewrites a saved option, changes a runner pin or replaces a command that another
project already adopted. A legacy workflow keeps its finite provider timeout
until a lead deliberately initializes a new workflow with the policy. This is a
deliberate compatibility boundary, not an incomplete migration.

## Adopting V1.3 in another project (Shello seam)

The adoption path keeps the source checkout and the target project separate and
makes no assumption about a global installation.

1. A ready host verifies the published source pin and the build output before
   anything else. Record the exact adopted source commit, the build result and
   the built CLI hash, and compare them with the pins the project published.
2. The host invokes the pinned absolute CLI directly, from the project being
   developed, and writes its local run manifest somewhere the project ignores
   (for example under an untracked local state directory). The manifest is
   local evidence; it is not committed, copied into workflow state or used as
   input to a provider.
3. The host initializes the new workflow with the supervised policy when the
   project wants unbounded implementer and reviewer calls, and leaves the policy
   out when it does not.
4. Before dispatch, the host inspects the saved policy, actors and budgets with
   `status` and `usage` as above, and only then runs, reviews and verifies.

No root-bound helper, portable wrapper or privileged installation step is
required for this path, and none is implied by it. Keep any runner the project
already activated, including its existing cutoff: an old R4 runner and its
one-hour bound stay in force for the workflows that were saved against it, and
V1.3 does not rewrite them.

A future wrapper that needs to bound its own non-provider controller call can
select the low-level `timeoutMs: null` process mode directly. That is a
controller-side choice about one child process; it is not the workflow policy,
must not be reported as a supervised provider, and must not be used to relax the
finite timeout of worker-declared checks or integrated verification.

## Verification

The focused checks that accompany V1.3 cover CLI initialization, help, refusal
and status; schema-1 and schema-2 loading with the policy present and omitted;
malformed saved-state refusal; policy immutability; implementer and reviewer
forwarding; finite worker-declared and integrated verification calls; and
single-dispatch behavior after `workflow_output_incomplete`. The forwarding
evidence is a real delayed provider fixture that outlives the paired former
finite threshold under the supervised policy while a delayed local check at that
same saved timeout still fails finitely. No hour-long test is part of the suite.
