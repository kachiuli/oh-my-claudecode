# Workflow V1.4 capability matrix

Donor: [`kachiuli/oh-my-codex` 0.21.5 at `cb955b0d`](https://github.com/kachiuli/oh-my-codex/tree/cb955b0d5becbef76d2c1f0096b6e1f238e1e7f7). Donor code is read-only architectural evidence, not target policy. OMC remains the only workflow engine and writer.

| Capability                                            | Classification         | Workflow V1.4 result                                                                                                                                                                                        |
| ----------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project host setup and scoped paths                   | Required               | Atomic `setupProjectHosts`, project-owned receipt/backups, narrow local-state ignore rules, idempotent refresh and collision refusal.                                                                       |
| Shared CLAUDE.md/AGENTS.md guidance                   | Adapter                | Both marker-bounded projections derive from `templates/hosts/orchestrator-guidance.md` and retain user text.                                                                                                |
| Native skills and role agents                         | Adapter                | Install the existing OMC skill guidance and role catalog; Codex TOML projections omit model pins. OMX roles are not imported.                                                                               |
| Claude project plugin                                 | Adapter                | Managed plugin contains role agents, skill, MCP pointer and supported lifecycle hooks; launch adds `--plugin-dir`.                                                                                          |
| Codex repository plugin                               | Adapter                | Repository marketplace plus compatibility plugin, project enablement, skill and supported lifecycle hooks. A direct project MCP pointer and fallback skill keep the project operable before plugin refresh. |
| Native lifecycle events                               | Adapter                | Translate `SessionStart`, `UserPromptSubmit`, `Stop`, and advisory `SessionEnd`; exact hook trust remains user state.                                                                                       |
| Unsupported or bypassed lifecycle                     | Deferred with fallback | Explicit CLI checkpoints, lease checks, publication checks and core operation gates remain authoritative. No native parity claim.                                                                           |
| Launch and native resume                              | Adapter                | Shell-free launch from a fixed repository working directory, inherited native permission behavior, same-host recorded-session resume and a fresh session after switching.                                   |
| Host selection, leases and handoff                    | Core                   | Shared supported hosts, ignored local selection, operation gate, revocable lease, quiescent handoff and explicit recovery.                                                                                  |
| Worktree ownership and session paths                  | Core                   | Existing OMC Git/worktree utilities remain authoritative; session state uses canonical resolvers.                                                                                                           |
| Team/subagent execution                               | Core                   | Existing workflow/team controller and provider bindings; Codex or Claude is the lead, never an inferred worker provider.                                                                                    |
| MCP and tool integration                              | Adapter over core      | Register the existing OMC bridge. OMX state/tool servers are not copied.                                                                                                                                    |
| Authentication and provider config                    | Required isolation     | User/private OpenAI, Anthropic and Z.AI configuration is not copied, printed or rewritten.                                                                                                                  |
| Exact GLM model identifiers                           | Required compatibility | Preserve `glm-5.3`, `glm-5.3-flash`, and `glm-5.3-flash[1m]`; no substring routing or suffix normalization.                                                                                                 |
| Doctor, update and uninstall                          | Adapter                | Receipt diagnostics, CLI/feature probe, idempotent update and exact-ownership uninstall; modified user assets are preserved.                                                                                |
| Workflow state machine, budgets and review gates      | Core                   | One existing OMC V1/V2 controller, including V1.3 policy and immutable attempt history.                                                                                                                     |
| Designated result publication (#4)                    | Core                   | Only the caller-designated artifact is eligible; bytes, schema and task identity are reverified without stdout replay/backfill.                                                                             |
| Protected refs (#5)                                   | Core                   | Bounded phase deltas and narrow root-tree checkpoint evidence; unknown attribution, mutation/deletion and overflow fail closed.                                                                             |
| Usage accounting and redaction                        | Core                   | Existing OMC process accounting and credential boundaries are retained.                                                                                                                                     |
| OMC state upgrade                                     | Required compatibility | Existing reads remain no-op and project adoption does not rewrite workflow state.                                                                                                                           |
| Arbitrary OMX workflow import                         | Deferred               | Schemas differ. No partial translation or concurrent writer; finish live OMX work before OMC adoption.                                                                                                      |
| OMX Rust harnesses, sparkshell, wiki and HUD variants | Optional, excluded     | Outside the Workflow V1.4 host-adapter scope. Existing OMC notification launch options remain shared; no donor notification subsystem is copied.                                                            |

Compatibility references:

- [Codex advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex plugin packaging and repository marketplaces](https://developers.openai.com/plugins/build/plugins)
- [Codex skills](https://learn.chatgpt.com/docs/build-skills)
- [Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Claude Code plugins](https://code.claude.com/docs/en/plugins)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Z.AI GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3)
- [Z.AI GLM-5.3 Flash](https://docs.z.ai/guides/vlm/glm-5.3-flash)
- [Z.AI latest-model aliases](https://docs.z.ai/devpack/latest-model)
- [Issue #4](https://github.com/kachiuli/oh-my-claudecode/issues/4)
- [Issue #5](https://github.com/kachiuli/oh-my-claudecode/issues/5)
