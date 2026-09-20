# workflow-v1.4 acceptance and evidence specification

Tests run in temporary repositories and homes/configuration directories. No test may modify real Claude, Codex, OpenAI, Anthropic or Z.AI settings. Synthetic executable evidence must remain labelled synthetic; a missing credential is not an authenticated pass.

## Acceptance matrix

| Area              | Required assertions                                                                                                                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dual setup        | Both assets present; idempotent setup/update; existing user instructions/settings/hooks survive; collisions fail safely; one host uninstall retains the other and shared state; rollback restores owned changes.                                                           |
| Selection         | Claude → Codex → Claude, repeated switches, local selection overriding shared default, status reports both CLIs; missing selected CLI fails without fallback; assets and provider bindings remain byte-identical.                                                          |
| Safe handoff      | Before work, completed stage and paused/checkpointed workflow accepted; live process, active attempt, lock/lease and verify/review/adjudication mutation block; operation/selection race prevented; revoked host cannot mutate.                                            |
| Sessions/history  | Cross-host stale identifiers refused; fresh native session after switch; same OMC checkpoint; every new invocation retains its original host; V1/V2 legacy bytes unchanged by reads; immutable attempts and budgets.                                                       |
| Native Codex lead | Codex starts with OMC lead instructions/tools, starts a workflow and resumes a shared checkpoint; Claude/GLM/Codex role routing remains independent; supported native lifecycle payloads translated, missing event fallbacks explicit.                                     |
| V1.3              | Both orchestrators exercise claude-glm-codex and role substitution, explicit lead/implementer/reviewer bindings, supervised provider policy, finite declared checks, acceptance/verification/review/adjudication/finish, retained failure evidence and no silent fallback. |
| GLM variants      | Exact glm-5.3, glm-5.3-flash and glm-5.3-flash[1m] survive routing; explicit provider identity; credentials isolated; model availability claims only where documented and authenticated.                                                                                   |
| Issue #4          | Local/stdout-only valid handoff fails at missing designated artifact with normally completed process output; correct exclusive publication preserves bytes and reaches replay; malformed/mismatched/symlink/overwrite rejected; no retry/backfill.                         |
| Issue #5          | Protected branch/tag additions/movement/deletion fail; worker checkpoint-shaped mutation fails; bounded phase diagnostics preserved privately; narrowly evidenced post-provider root-tree checkpoint allowed; unknown or related checkpoint and overflow fail.             |
| Upgrade/migration | Legacy OMC reads are no-op; project adoption preserves workflow state; incompatible OMX schemas refused explicitly; setup rollback and host uninstall preserve user files and other host.                                                                                  |

## Verification gates

1. Focused unit/subprocess and integration regressions for all changed behavior.
2. Formatting of changed source, lint, TypeScript, full build.
3. Full supported unit/integration suites; distinguish existing platform limitations using baseline evidence.
4. Generated plugin shipping surface, skill entitlements, prompt projections and inventory checks.
5. Existing static/security checks and dependency audit; no new dependencies.
6. Package and isolated clean-install smoke, upgrade/rollback/dual-host tests against the packaged CLI.
7. Windows and Linux CI matrix, macOS for POSIX/tmux behavior. Local runs and configured-but-unrun hosted jobs must be reported separately. No push/CI dispatch without authorization.
8. Independent code/security review after implementation and fixes for confirmed findings.

## End-to-end sequence

Initialize both hosts; run a V1.3-style workflow with Claude; checkpoint; switch to Codex and continue; start a new Codex workflow; switch back without reinstalling. Exercise regular GLM and Flash under each host, issue #4 under both, issue #5 with each host including external Codex activity, then load an existing V1.3 workflow and compare raw bytes. Retain exact commands, exit statuses, test totals, CLI versions, baseline/final commits and platform/authentication limitations in the release evidence file.
