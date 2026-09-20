# Workflow V1.4 verification record

This record distinguishes implementation, synthetic workflow tests, native CLI compatibility checks, and authenticated execution. A configured CI job or an offline CLI invocation is not evidence of a live model call.

## Source identity

- Local branch: `codex/switchable-orchestrator-v1.4`.
- Fork `main` baseline: `b0e93d57c264dab85a6605061d1c3e0ca73e0c06`.
- Included custom V1.3 source: `1a17a6845b2a87c5ba5b85a195dc3cae0d3bc07f`.
- Read-only OMX donor: `cb955b0d5becbef76d2c1f0096b6e1f238e1e7f7`, version 0.21.5.
- Package version: 5.4.0. The workflow label does not change the package version.
- Final commit: recorded in the delivery response; this document cannot contain its own commit hash. `git rev-parse HEAD` identifies the delivered checkout.

No push, pull request, merge, tag, publication, release, or issue closure was performed.

## Behavior and reuse

`omc setup --host both --scope project` installs both host surfaces. `omc orchestrator use claude|codex` changes ignored local selection, `omc orchestrator status` reports both executables, and `omc launch` starts the selected native application. Selection does not rewrite assets or worker bindings. Explicit handoff records a quiescent checkpoint and revokes the previous lead credentials. Host-specific native sessions are tied to the selection revision; cross-host or stale sessions cannot resume.

The implementation reuses the OMC controller, schemas, provider registry, explicit GLM authentication route, worktree checks, workflow budgets, review gates, redaction, atomic writes, file locks and session-path helper. Both guidance surfaces project the same source and existing agent catalog. The existing notification argument extraction is shared with project launch, removing duplicated environment assignments. Publication and protected-ref diagnostics were extracted into focused modules. No dependency or copied OMX engine was added.

## Changed surfaces

| Files                                                                                                   | Change                                                                                                          |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/orchestration/{selection,state}.ts` and tests                                                      | Selection, leases, sessions, handoff and mutation authority.                                                    |
| `src/hosts/` and `templates/hosts/`                                                                     | Native host adapters, transactional owned setup, hooks, doctor and shared guidance.                             |
| `src/cli/project-launch.ts`, `src/cli/commands/orchestrator.ts`, CLI wiring and tests                   | Project host commands and direct native launch.                                                                 |
| `src/cli/launch.ts`                                                                                     | Reuse notification option translation for both launch paths.                                                    |
| `src/lib/worktree-paths.ts` and tests                                                                   | Separate project-owned configuration paths from runtime state relocation.                                       |
| `src/team/workflow*.ts`, workflow tests and fixture helpers                                             | Immutable host provenance, issue #4 publication, issue #5 ref audit, child authority and credential separation. |
| `scripts/smoke-{project,native-project}-hosts.mjs`, `package.json`                                      | Isolated packaged installation and native offline compatibility checks.                                         |
| `.github/workflows/workflow-v14.yml`                                                                    | Windows/Linux/macOS compatibility jobs; not dispatched.                                                         |
| `README.md`, migration/compatibility guides, V1.4 guide/release notes and `docs/design/workflow-v1.4-*` | Adoption, rollback, architecture, donor boundaries and acceptance specification.                                |
| Generated runtime closure and inventory                                                                 | Rebuilt shipped modules/bundles and repository inventory.                                                       |

Use `git diff --name-only b0e93d57c264dab85a6605061d1c3e0ca73e0c06 HEAD` for the exact manifest, including generated files.

The baseline already contains source/build drift in several shipped runtime modules. The build refreshes the required shipping closure, including those modules; unrelated generated tests and source maps are excluded from the delivery diff. No unrelated source implementation was rewritten to conceal that drift.

## Evidence classes and support matrix

| Surface                            | Synthetic/local evidence                                                                                                                                       | Authenticated/hosted evidence                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Claude lead                        | Native executable launch/parser/plugin checks, isolated setup, shared core and workflow tests                                                                  | No authenticated lead workflow in this run.                     |
| Codex lead                         | Native executable launch/parser/MCP/marketplace checks, isolated setup, shared core and workflow tests                                                         | No authenticated lead workflow in this run.                     |
| Claude/Codex workers and reviewers | Real subprocess fixtures exercise existing routes under both selected hosts                                                                                    | No live provider invocation in this run.                        |
| GLM / Flash                        | Exact `glm-5.3`, `glm-5.3-flash`, `glm-5.3-flash[1m]` retained on explicit GLM route under each host; installed wrapper inspected without printing credentials | Current account entitlement and live model behavior unverified. |
| Windows                            | Local Node 24.18.1 / npm 11.16.0; supported Windows suites, host/workflow regressions and isolated package installation                                        | New hosted job not run.                                         |
| Linux                              | Debian bookworm, Node 24.18.1, non-root Docker runner with bash/git/jq/tmux and native SQLite                                                                  | Local container evidence; hosted job not run.                   |
| macOS                              | CI job configured                                                                                                                                              | Not run; POSIX/tmux release acceptance remains open.            |

The installed CLIs checked were Claude Code 2.1.272 and Codex 0.155.0-alpha.9. Temporary HOME, USERPROFILE, CLAUDE_CONFIG_DIR and CODEX_HOME paths isolated the smoke checks. Native plugin discovery and schema validation are stronger than fixtures but do not establish hook trust, model authentication or a completed native conversation. No credential-unavailability claim is made: authenticated requests were not exercised.

## Verification results

Commands ran from the isolated checkout. Logs are retained locally under `.tmp-v14-evidence/`; they are not shipped as product files.

| Gate                                  | Command / scope                                                                                                                                                             | Result                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows workflow regressions          | `npx vitest run src/team/__tests__/workflow src/cli/commands/__tests__/team-workflow.test.ts --maxWorkers=2`                                                                | Exit 0; 13 files; **470 passed, 1 skipped**.                                                                                                    |
| Windows core and launch compatibility | `npx vitest run src/orchestration src/cli/__tests__/project-launch.test.ts src/cli/__tests__/launch.test.ts src/cli/commands/__tests__/orchestrator.test.ts --maxWorkers=2` | Exit 0; 4 files; **225 passed, 3 skipped**.                                                                                                     |
| Windows supported suite               | Existing `test-windows` file list in `.github/workflows/ci.yml`, `npx vitest run --fileParallelism=false`                                                                   | Exit 0; all 18 files; **342 passed, 2 skipped**.                                                                                                |
| Host installation and adapters        | `npx vitest run src/hosts --maxWorkers=1`                                                                                                                                   | **23 passed**; includes ownership, collisions, setup rollback, upgrade, ignore rules, hooks and retained other-host assets.                     |
| Type checking and build               | `npx tsc --noEmit`; `npm run build`                                                                                                                                         | Exit 0; generated runtime rebuilt.                                                                                                              |
| Lint                                  | `npm run lint`                                                                                                                                                              | Exit 0; zero errors, one pre-existing unused `realpathSync` warning in `src/team/git-worktree.ts`.                                              |
| Formatting                            | `npx prettier --check` on all new source/tests, host templates, smoke scripts, CI and V1.4 documents                                                                        | Exit 0. Existing compact workflow files retain their established formatting; `git diff --check` passes.                                         |
| Static path contract                  | `node scripts/ci/check-multirepo-paths.mjs`                                                                                                                                 | Exit 0; no raw OMC constructions outside the approved path boundary.                                                                            |
| Generated guidance                    | `npm run verify:skill-entitlements`; `npm run verify:prompt-projections`; `npm run prompt-ssot:check`                                                                       | Exit 0 for all three.                                                                                                                           |
| Dependency security                   | `npm audit --omit=dev --json`                                                                                                                                               | Exit 0; **zero reported production vulnerabilities**.                                                                                           |
| Native CLI checks                     | `node scripts/smoke-native-project-hosts.mjs <claude.exe> <codex.exe>`                                                                                                      | Exit 0; Claude plugin validation, Codex trusted-project MCP/marketplace parsing, both native help launches and lease release. No model request. |

The concluding Linux, package, inventory, shipping and core-launch results are added after the final snapshot checks.

The same Linux runner on unmodified `main` produced **752 passed files, 2 failed files, 2 skipped files; 14,655 passed tests, 10 failed tests, 22 skipped tests** (756 files / 14,687 tests). All ten failures are the existing HUD emoji expectations in `src/__tests__/hud/call-counts.test.ts` and `src/__tests__/hud/windows-platform.test.ts`. Docker exposes a WSL kernel; production correctly chooses the ASCII fallback while these tests assume a non-WSL Linux kernel. Candidate results are compared with this baseline without modifying those tests.

## Independent review

Separate agents reviewed code they did not author. Confirmed findings were corrected with regressions, including publication capability binding and exact bytes, protected-ref ancestry, setup ownership and TOML collisions, provider credential/worker authority separation, native launch argument escapes, stale lead revocation and bounded handoff persistence. Independent final reviews approved the core, repository/workspace isolation, publication/ref audit and owned host installation. Installed native help also exposed background/session-manager/desktop/queued transports; the launcher refuses those unmanaged routes.

## Remaining release gates and operational limits

- Authenticated Claude/Codex lead workflows and live provider/model availability require separate evidence. Hook delivery depends on native support and exact user trust; core gates remain authoritative without hooks.
- Hosted Windows/Linux and macOS jobs were not run because nothing was pushed or dispatched.
- The repository's generated-artifact authorization gate requires a trusted owner authorization for changed `dist/` and `bridge/` artifacts. A candidate-branch edit cannot authorize itself. The release does not modify that policy or manufacture an authorization.
- Operation locks fail closed and are never automatically reaped. Crash recovery may require verifying all owners/providers are dead, removing only the exact abandoned operation lock, and recording explicit recovery. See the [operator guide](WORKFLOW-V1.4.md).
- Uninstall refuses the active or final host. It preserves modified user-owned assets and shared workflow state.
- Orchestrator runtime history is bounded by 10,000 handoffs and 4 MiB of serialized UTF-8 state. An operation that would exceed either limit is refused before replacing readable state; history is not silently pruned.
- Native user permissions, readable roots and network configuration remain native configuration. The launcher refuses explicit bypass/remote redirection; it does not implement a second operating-system sandbox.
- Arbitrary OMX state import, donor-only UI/HUD/wiki/notification systems, Rust harnesses and sparkshell are deferred. No partial migration or competing OMX writer is enabled. See the [capability matrix](design/workflow-v1.4-capabilities.md).

Review readiness and release readiness are separate decisions. Final readiness is stated only after the source-stable verification results below have been populated.
