# ADR: repository-scoped orchestration hosts

Status: accepted for implementation; release acceptance remains gated by the test specification.

## Baselines and scope

On 2026-09-21, the fork's remote `main` resolved to `b0e93d57c264dab85a6605061d1c3e0ca73e0c06`. It contains custom V1.3 source `1a17a6845b2a87c5ba5b85a195dc3cae0d3bc07f`. The isolated implementation branch starts at that `main`, not the pre-existing local V1.1 branch. Donor `kachiuli/oh-my-codex` resolved to `cb955b0d5becbef76d2c1f0096b6e1f238e1e7f7` and declares version 0.21.5. Package version remains 5.4.0; workflow-v1.4 is a separate release label.

## Decision

Keep the existing OMC workflow controller, task schemas, provider adapters, budgets, verification/review gates, worktree ownership, usage accounting and redaction as the single core. Add project host selection and thin installation/launch adapters. A host selects the interactive lead application; provider bindings independently select the implementer and reviewer. Switching hosts cannot rewrite bindings or historical attempts.

Shared repository configuration declares supported hosts and an optional default. Ignored local repository state selects the current user's active host. Explicit selection takes precedence over the default. An unavailable selected CLI is an error with installation guidance. Legacy repositories keep the existing Claude launch behavior until they adopt project setup.

Host installation prepares managed Claude and Codex assets once. Managed blocks and owned files preserve surrounding user configuration and refuse collisions. Setup, update and uninstall use ownership evidence; removing one host retains the other host and shared workflow state. Both host guidance projections derive from one source. Codex uses native project instructions, skills, agents, supported hooks and the existing OMC CLI/MCP transport, never a copied OMX workflow engine.

## Switching and sessions

Selection and controller mutations use the same repository operation gate. A running provider, operation lock, active attempt, or host lease blocks selection. Explicit handoff is permitted only at a quiescent checkpoint; it records the boundary and invalidates the old host lease. The old host cannot continue mutating after handoff. A paused workflow remains ordinary OMC state; switching does not migrate it. An uncertain/stale running record fails closed until explicit recovery establishes quiescence.

Each new implementation/review invocation records its orchestration host. Missing historical host fields remain missing on read; old history is never backfilled. Host session identifiers are namespaced by host and are not worker-provider sessions. A host switch starts a fresh host session while retaining the workflow checkpoint. Session-scoped filesystem paths use `resolveSessionStatePaths()` exclusively.

## Result publication and protected refs

Issue #4: distinguish dispatch envelope, canonical task, helper-local JSON and the designated result file. The worker validates and publishes the exact verified bytes exclusively to that path, re-reads and verifies bytes/schema/task identity before ending. Existing evidence is never overwritten; stdout is not a worker handoff and cannot trigger replay. Preserve the existing bounded native Claude reviewer structured-output transport as a separate legacy adapter contract.

Issue #5: persist bounded local protected-ref deltas at provider and replay boundaries. Routine diagnostics do not reveal private refs or object IDs and do not claim an unknown writer is the worker. A checkpoint-shaped name alone proves nothing. Only a new checkpoint observed after provider completion, absent at that boundary, matching the captured root checkout tree and unrelated to worker commits/trees is eligible for the documented narrow exception. Additions during provider execution, mutations/deletions, other namespaces, incomplete evidence and overflow fail closed.

## Compatibility and migration

Existing OMC V1/V2 schema files, including V1.3 supervised policies, remain byte-stable on read. Host fields are additive only for new invocations and remain immutable. GLM Flash is an exact model identifier on the existing explicit GLM provider route. No substring inference or model suffix normalization is introduced. OpenAI, Anthropic and Z.AI credentials remain in their independent private configuration profiles.

OMX state is a different product schema. This release must not guess translations or run an OMX writer against unified workflows. Any supported import must validate its source schema and provide dry-run, backup, provenance, idempotence and rollback together; otherwise fail explicitly and document that existing OMX workflows must finish in OMX before initializing an OMC workflow. OMC upgrades themselves require no state migration.

## Cleanup and implementation plan

1. Reuse existing workflow/process/provider/path/lock utilities; leave the legacy controller intact. Extract only narrowly reusable publication/ref diagnostics when necessary.
2. Add host-neutral selection, operation gating and provenance. Keep worker routing unchanged.
3. Adapt donor project installation, hook translation and launcher conventions without copying its engine, catalogs or provider registry. Preserve ownership and user files.
4. Wire project setup, orchestrator use/status/handoff, launch, doctor, update and uninstall into the existing CLI.
5. Add regressions before broad verification; review the implementation independently and address confirmed findings.
6. Run supported platform, package, generated-artifact, inventory and security checks. Record synthetic and authenticated results separately. Do not publish, push, tag or close issues.

## Tradeoffs

A quiescent handoff can require a fresh host conversation, but avoids pretending that native sessions are portable. Conservative locks can require explicit recovery after a crash, but protect in-flight state. Lifecycle parity is capability-based: unsupported native hook events use explicit CLI checkpoints and core gates; no lifecycle hook is trusted to enforce a gate that the core can enforce itself. Existing global installation remains available for backward compatibility; the new dual-host interface is explicitly project scoped.
