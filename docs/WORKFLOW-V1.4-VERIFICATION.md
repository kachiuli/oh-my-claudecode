# Workflow V1.4 verification record

This record distinguishes implementation, synthetic workflow tests, native CLI compatibility checks, and authenticated execution. A configured CI job or an offline CLI invocation is not evidence of a live model call.

## Source identity

- Local branch: `codex/switchable-orchestrator-v1.4`.
- Fork `main` baseline: `b0e93d57c264dab85a6605061d1c3e0ca73e0c06`.
- Included custom V1.3 source: `1a17a6845b2a87c5ba5b85a195dc3cae0d3bc07f`.
- Read-only OMX donor: `cb955b0d5becbef76d2c1f0096b6e1f238e1e7f7`, version 0.21.5.
- Package version: 5.4.0. The workflow label does not change the package version.
- Full-suite source snapshot: `13b67c52da790976a99f6bc2d05e8c1d1f9e68f1` (implementation at `e810e25aa41e59fe67673a6bdfad4694b083648d` plus inventory). Later delivery changes remove out-of-closure generated declarations and update this evidence/inventory; application source is unchanged.
- Final commit: recorded in the delivery response; this document cannot contain its own commit hash. `git rev-parse HEAD` identifies the delivered checkout.

The candidate is published as [PR #6](https://github.com/kachiuli/oh-my-claudecode/pull/6), targeting `main`. The owner subsequently authorized continuing through release. Release identity remains `workflow-v1.4`; this does not publish a new npm version or reuse a historical `v1.4.x` tag.

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
| `.github/workflows/{ci,workflow-v14}.yml`                                                               | Windows/Linux/macOS host compatibility matrix, reused by the existing CI entry point.                           |
| `README.md`, migration/compatibility guides, V1.4 guide/release notes and `docs/design/workflow-v1.4-*` | Adoption, rollback, architecture, donor boundaries and acceptance specification.                                |
| Generated runtime closure and inventory                                                                 | Rebuilt shipped modules/bundles and repository inventory.                                                       |

The candidate delta contains 119 paths, including 65 shipped runtime artifacts. Use `git diff --name-only b0e93d57c264dab85a6605061d1c3e0ca73e0c06 HEAD` for the exact manifest, including generated files. The base-owned authorization manifest is separate release-control metadata.

The baseline already contains source/build drift in several shipped runtime modules. The build refreshes the required shipping closure, including those modules; unrelated generated tests, source maps and 20 new internal declaration files outside the base-authorized PR closure are excluded from the delivery diff. No unrelated source implementation was rewritten to conceal that drift.

## Evidence classes and support matrix

| Surface                            | Synthetic/local evidence                                                                               | Authenticated/hosted evidence                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Claude lead                        | Native executable launch/parser/plugin checks, isolated setup, shared core and workflow tests          | Live call rejected; stored login requires renewal.                                                          |
| Codex lead                         | Native executable launch/parser/MCP/marketplace checks, isolated setup, shared core and workflow tests | Authenticated native lead initialized and read shared workflow state; lease released.                       |
| Claude/Codex workers and reviewers | Real subprocess fixtures exercise existing routes under both selected hosts                            | Live workflow provider verification in progress.                                                            |
| GLM / Flash                        | Exact `glm-5.3`, `glm-5.3-flash`, `glm-5.3-flash[1m]` retained on explicit GLM route under each host   | Exact Flash call passed; regular GLM and Flash `[1m]` returned HTTP 403. Endpoint verification in progress. |
| Windows                            | Local Node 24.18.1 / npm 11.16.0; supported suites and isolated package installation                   | Hosted validation in progress.                                                                              |
| Linux                              | Debian bookworm, Node 24.18.1, non-root Docker with bash/git/jq/tmux and native SQLite                 | Hosted host matrix passed; full suite passed 14,792 tests with one inventory drift failure.                 |
| macOS                              | Hosted run reproduced canonical temporary-directory fixture mismatches                                 | Fixture correction under verification.                                                                      |

The installed CLIs checked were Claude Code 2.1.272 and Codex 0.155.0-alpha.9. Temporary HOME, USERPROFILE, CLAUDE_CONFIG_DIR and CODEX_HOME paths isolated the offline smoke checks. Native plugin discovery and schema validation are stronger than fixtures but do not establish hook trust, model authentication or a completed native conversation.

## Authenticated execution

The native Codex lead completed `omc launch exec` using the existing ChatGPT authentication store, `gpt-5.6-luna`, low reasoning, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, and OMC's `workspace-write` sandbox. In a disposable repository, the model read the installed project skill and issued three successful OMC commands: orchestrator status, workflow initialization, and workflow status. Persisted state confirmed a pending task with zero attempts; the lease was released and the `native-host-process-exited` checkpoint recorded. This proves authenticated native lead mutation of the shared core, but this particular smoke did not dispatch a worker. An initial disposable output-schema error was corrected before the successful call; it was not a workflow task retry.

The installed GLM wrapper completed a bounded live call for exact model `glm-5.3-flash`, with the expected response and exit 0. Exact `glm-5.3` returned HTTP 403 / code 1313 on that wrapper's configured route; exact `glm-5.3-flash[1m]` also returned HTTP 403. Endpoint verification is in progress before attributing these responses to a particular provider account or policy. No fallback model was requested, and neither rejected variant is counted as live-compatible by this probe.

Claude's initial stored-login status was positive, but bounded model calls failed before any tool execution. A subsequent status check reported logged out. The attempted native Claude lead created no workflow state. Completing its authenticated workflow evidence requires a renewed login; offline compatibility and synthetic workflow tests remain separate evidence.

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

Packaging used `npm pack --ignore-scripts --pack-destination .tmp-v14-evidence` after the successful build, followed by `npm run smoke:project-hosts -- <tarball>` on Windows and Linux. Both clean installations exited 0, including a real native SQLite query, dual setup, idempotent upgrade, repeated host switching, preserved user files and independent uninstall. CLI discovery executables in this smoke are synthetic; provider authentication is not exercised. The tested tarball's SHA-256 is `ce40f961594f86528e20fbff694286427601dc1d0532d5057026fb0084f4b23d`.

The Linux command was `npm run test:run -- --maxWorkers=4`, after `npm run build`, in the same Debian/Node image used for the baseline. The final runner uses Docker `--init` so orphaned test children are reaped. Result: **758 passed files, 2 failed files, 2 skipped files; 14,783 passed tests, 10 failed tests, 22 skipped tests** (762 files / 14,815 tests), exit 1, 302.86 seconds. The ten failed test names exactly match the baseline below: **128 additional passing tests and no additional failures**. An earlier runner without an init process retained orphan zombies and was discarded; its affected process-reaping regression passed in the corrected runner and in the final full run.

`npm run plugin:shipping:check-pr -- --base b0e93d57c264dab85a6605061d1c3e0ca73e0c06` passed from a clean Linux checkout: **1,264 required runtime artifacts, 65 generated changes**. The Windows invocation hits the existing script's native command-line length limit when passing the complete path list to Git (`spawnSync git ENAMETOOLONG`); the Linux result is the qualifying shipping check. The base-authorized closure excludes the 20 newly generated internal declarations that the broader local staging helper initially included.

`npm run generate:inventory:verify` passes after regenerating the inventory for the delivered tracked file set. The separate command `node scripts/ci/check-no-committed-build-artifacts.mjs --base b0e93d57c264dab85a6605061d1c3e0ca73e0c06 --head <delivered-HEAD>` intentionally exits 1 with **OWNER_CONFIRMATION_REQUIRED**: the base-owned authorization manifest has no authorization for this candidate's generated delta. Passing shipping correctness does not satisfy that owner-controlled release policy.

The same Linux runner on unmodified `main` produced **752 passed files, 2 failed files, 2 skipped files; 14,655 passed tests, 10 failed tests, 22 skipped tests** (756 files / 14,687 tests). All ten failures are the existing HUD emoji expectations in `src/__tests__/hud/call-counts.test.ts` and `src/__tests__/hud/windows-platform.test.ts`. Docker exposes a WSL kernel; production correctly chooses the ASCII fallback while these tests assume a non-WSL Linux kernel. Candidate results are compared with this baseline without modifying those tests.

## Independent review

Separate agents reviewed code they did not author. Confirmed findings were corrected with regressions, including publication capability binding and exact bytes, protected-ref ancestry, setup ownership and TOML collisions, provider credential/worker authority separation, native launch argument escapes, stale lead revocation and bounded handoff persistence. Independent final reviews approved the core, repository/workspace isolation, publication/ref audit and owned host installation. Installed native help also exposed background/session-manager/desktop/queued transports; the launcher refuses those unmanaged routes.

Hosted macOS exposed nine fixture mismatches because its temporary directory has both `/var` and physical `/private/var` spellings. Four fixture constructors now use physical temporary roots, matching the production contract. An independent Linux symlinked-`TMPDIR` reproduction failed before the correction and passed afterward: 215 affected tests plus the specific workflow publication case. The same six affected Windows suites passed 274 tests. Production canonical-path and publication authority checks were unchanged.

## Remaining release gates and operational limits

- Authenticated Claude/Codex lead workflows and live provider/model availability require separate evidence. Hook delivery depends on native support and exact user trust; core gates remain authoritative without hooks.
- Hosted Windows/Linux/macOS validation is running through [CI](https://github.com/kachiuli/oh-my-claudecode/actions/runs/35540860164); initial macOS temporary-path fixture mismatches and inventory drift after CI wiring are being corrected before release acceptance.
- The repository's generated-artifact authorization gate requires a trusted owner authorization for changed `dist/` and `bridge/` artifacts. A candidate-branch edit cannot authorize itself. The release does not modify that policy or manufacture an authorization.
- Operation locks fail closed and are never automatically reaped. Crash recovery may require verifying all owners/providers are dead, removing only the exact abandoned operation lock, and recording explicit recovery. See the [operator guide](WORKFLOW-V1.4.md).
- Uninstall refuses the active or final host. It preserves modified user-owned assets and shared workflow state.
- Orchestrator runtime history is bounded by 10,000 handoffs and 4 MiB of serialized UTF-8 state. An operation that would exceed either limit is refused before replacing readable state; history is not silently pruned.
- Native user permissions, readable roots and network configuration remain native configuration. The launcher refuses explicit bypass/remote redirection; it does not implement a second operating-system sandbox.
- Arbitrary OMX state import, donor-only UI/HUD/wiki/notification systems, Rust harnesses and sparkshell are deferred. No partial migration or competing OMX writer is enabled. See the [capability matrix](design/workflow-v1.4-capabilities.md).

**Release candidate under verification in PR #6.** Release acceptance still requires completion of hosted validation, trusted generated-artifact authorization, and resolution or explicit acceptance of the disclosed authenticated host/provider limits. No tag or release has been published.
