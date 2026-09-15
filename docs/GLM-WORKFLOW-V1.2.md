# Workflow V1.2: explicit role substitution

Status: local candidate with passing integrated build, lint and selected
regressions. The CLI examples below are implemented, but they are not a published
release or an authenticated compatibility claim. Consult the
[V1.2 validation report](GLM-WORKFLOW-V1.2-VALIDATION.md) before selecting a runner.
The [V1/V1.1 guide](GLM-WORKFLOW.md) and existing saved runs remain supported on
their original schema and runner pins.

V1.2 separates the role from its provider, CLI family, selected model and private
authentication profile. The external lead may be Claude or Astra. Implementation
may use GLM or normal Claude; review may use Codex or normal Claude. A Codex
implementation adapter and GLM reviewer are outside this version's first scope.
The controller does not launch an external lead or prove its reasoning/model from
its caller's name.

Independent review is preferred, but self-review is allowed when needed without
another approval solely for matching author/reviewer identity. Fresh reviewer
context remains the supported initial path. Reports label the saved relationship
as independent, self-review or unknown; different provider names do not establish
independence. Same-session review permission transitions are not yet supported.

## Select a source checkout and a separate target project

These changes are local to this fork. An upstream npm or marketplace installation
does not select this candidate. Do not change a global command or replace an old
runner implicitly. Record the exact adopted source commit, build result and built
CLI hash before using it for another project.

From the chosen fork checkout, with its locked dependency set:

```text
npm ci --no-audit --no-fund
npm run build
node bridge/cli.cjs team workflow --help
```

Then run the absolute built CLI from the project being developed. For example,
in native PowerShell, after replacing the example paths:

```powershell
$omcCli = 'C:/dev/omc-workflow-v1.2/bridge/cli.cjs'
Set-Location 'C:/dev/my-project-trial'
node $omcCli team workflow --help
```

Git, Node and selected provider executables must be available in the same host
environment. Native Windows launches use executable paths and argument arrays;
`.cmd`, `.bat` and PowerShell provider wrappers are not accepted as a substitute
for a directly executable adapter. Script executables also need evidence binding
the Node interpreter. Nothing here requires a global npm link or an npm version
change.

The lead supplies the full scoped plan, including owned files, dependencies,
acceptance criteria and exact executable checks. Use a dedicated integration
branch. Long controllers run under a monitored host that stays alive after a
headless lead returns; do not assume a detached background command survives the
lead's final answer. Preserve any interrupted state and lock for inspection.

## Public bindings and private runtime configuration

The plan retains the [existing plan schema](GLM-WORKFLOW.md#prepare-a-scoped-plan).
A separate public bindings file contains exactly `lead`, `implementer` and
`reviewer`. Each value follows
[`WorkflowRoleBinding`](../src/team/workflow-contracts.ts):

- A stable binding ID, role, provider route and CLI family.
- The exact selected model and optional effort. Context aliases such as
  `claude-fable-5-1[1m]` remain literal; no default-model fallback is implied.
- A nonsecret `authProfileRef` and the fingerprint of its selected private
  authentication sources.
- For executable roles, the absolute executable path, its SHA-256 and normalized
  version token, such as `2.1.258` rather than a full CLI banner.
- Required capabilities and the SHA-256 of a corresponding capability receipt.

Keep credentials, profile contents and private environment values outside the
project. Supply a separate absolute machine-local runtime file only when a
provider operation needs it. The JSON shape is:

```json
{
  "schemaVersion": 1,
  "profiles": {
    "normal-claude": {
      "providerRoute": "claude",
      "environment": {},
      "files": ["C:/private/omc/selected-auth-source.json"]
    }
  },
  "capabilityEvidence": {
    "claude-worker": "C:/private/omc/claude-worker-capabilities.json",
    "claude-reviewer": "C:/private/omc/claude-reviewer-capabilities.json"
  }
}
```

These are placeholders, not working authentication or capability evidence. Map
each `authProfileRef` to its real selected route/environment/files, and each
binding ID to its receipt. Enumerate the actual authentication sources; do not
invent a file or assume that a CLI name identifies a keychain/OAuth account. The
trusted setup runner uses `fingerprintWorkflowAuthProfile` to calculate the
binding fingerprint from those exact sources. Optional `redactionValues` stay
private and identify additional values the runner knows must not appear in logs.
Neither the configuration nor these values are copied into workflow state.

The CLI requires the private runtime configuration and private source files to
resolve outside the target project. It does not discover profiles automatically,
log their values, modify them, or enable synthetic capability receipts. Maintain
normal Claude, GLM and Codex routes separately. GLM routing variables must not
enter normal Claude; parent environment credentials are not implicitly inherited
by provider children.

## Establish executable and capability evidence

A receipt binds exact executable bytes, provider/role/CLI family, auth
fingerprint, capabilities, supported model/effort combinations and any executable
dependencies. Its original bounded JSON bytes must match the hash in the public
binding. A known logical actor ID is optional; it is not inferred from a Git
committer or the process accepting a worker's commit.

Authenticated compatibility must be established by a trusted bounded runner on
synthetic source. CLI help or a synthetic process is insufficient to label a
receipt authenticated. Do not fill in `validation: authenticated` merely to pass
preflight. See [L01–L05 in the acceptance plan](ROLE-SUBSTITUTION-TEST-PLAN.md#separate-bounded-live-compatibility-checks)
for the required distinctions. The current pending observations remain listed
in the validation report.

For initial setup, the trusted verification runner may explicitly allow
synthetic capability declarations through the programmatic `WorkflowRuntime`
seam, only on throwaway source used for the actual bounded L01–L05 probes. This
allows the runner to test the selected authenticated CLI before claiming its
compatibility. It may issue an authenticated receipt only after recording the
observed successful version, exact argv, model/effort, profile fingerprint,
structured-result behavior and required restrictions. The normal workflow CLI
has no synthetic bypass option. This bootstrap harness and its live observations
are pending; an example JSON file or `--help` output is not a substitute.

Before reserving a provider attempt, P2 checks the selected executable,
authentication fingerprint, receipt bytes and requested operation/model/effort.
A mismatch fails visibly and does not select another provider or lower the model.
Missing capability evidence is a setup failure, not permission to bypass checks.
Preflight diagnostics and reserved provider failures remain distinct evidence.

Optional `reviewAuthorship: {"path": "<absolute receipt>", "sha256": "<digest>"}`
in the private runtime points to a runner-owned receipt for the exact reviewed
head, complete author coverage and known logical actor IDs. Without that evidence
or a known reviewer identity, the recorded relation is unknown. Self-review is
allowed and reported truthfully.

## Start a new V1.2 workflow

Explicit selection creates schema version 2 with the `role-substitution` profile.
Balanced mode retains shared context, usage accounting and guarded compatible
session continuation. V1.2 does not migrate or rewrite an old workflow.

```powershell
$runtimeFile = 'C:/private/omc/runtime.json'
node $omcCli team workflow init --file .omc/plans/feature.json --profile role-substitution --bindings .omc/plans/roles.json --mode balanced
node $omcCli team workflow run feature --runtime $runtimeFile
node $omcCli team workflow status feature
node $omcCli team workflow usage feature
```

Omitting `--profile` keeps legacy initialization. `--mode balanced` alone still
selects V1.1 behavior, not schema version 2. Old schemas, limits and historical
usage remain unchanged. The new profile requires explicit public bindings; a
runtime file is not accepted as an implicit migration of a legacy workflow.

After inspected worker completion, the existing explicit accept, verify, review,
adjudicate and finish gates still apply:

```powershell
node $omcCli team workflow accept feature backend
node $omcCli team workflow verify feature
node $omcCli team workflow review feature --runtime $runtimeFile
node $omcCli team workflow adjudicate feature --file .omc/plans/dispositions.json
node $omcCli team workflow finish feature
```

Use the actual task IDs and dispositions. Initialization, selection, a provider
exit of zero or a token count does not satisfy acceptance, verification or review.
Successful workflow completion is separate from project adoption, publication,
deployment or main-branch acceptance.

## Record a substitution without hidden retries

Inspect and retain the original failure before selecting a replacement. A public
intent file contains `role`, the complete new `binding`, `expectedHead`, `reason`,
`authorityRef`, and optionally `taskId` as audit context for an implementer
substitution. The selected role changes
globally for subsequent calls; `taskId` is not a per-task routing override.

```powershell
node $omcCli team workflow substitute feature --file .omc/plans/substitute-reviewer.json
node $omcCli team workflow status feature
node $omcCli team workflow review feature --runtime $runtimeFile
```

Selection appends old/new binding evidence and does not dispatch, reset counters
or raise limits. Every reserved failure remains charged. A test failure, malformed
handoff, path/schema error or scope violation is not provider unavailability.
There is no silent provider fallback, model fallback, automatic retry or cleanup
of interrupted workers. An active controller blocks concurrent selection.

Each later invocation retains its own immutable binding. Reports aggregate those
saved bindings, including failed attempts and earlier models; a current selection
never relabels old usage. Missing usage remains unknown and token observations
are not billing or savings estimates.

Explicit `resume` still requires the inspected head/reason, compatible confirmed
session, unchanged binding/auth/executable/model, task context and original clean
worktree. Add `--runtime` for a V1.2 resume. A cross-provider invocation is fresh;
never reuse a GLM session UUID as a normal Claude or Codex continuation. Exhausted
budgets or stale running state require inspection, not a new workflow used to
erase prior attempts.
