# Workflow V1.4 release notes

Workflow V1.4 adds repository-scoped Claude Code and Codex lead hosts over the existing OMC workflow core. It is implemented from the fork's `main` baseline `b0e93d57c264dab85a6605061d1c3e0ca73e0c06`. The package version remains 5.4.0.

## Delivered behavior

- Project setup, refresh, doctor and ownership-checked uninstall for Claude and Codex.
- Repository-local configuration with repository-keyed selection, fail-closed leases, safe checkpoints and fresh cross-host sessions under relocatable shared state roots.
- One shared guidance source projected to `CLAUDE.md`, `AGENTS.md`, native skills and the existing OMC agent catalog.
- A Claude project plugin and a Codex repository marketplace/compatibility plugin, plus supported native lifecycle adapters.
- Existing OMC MCP tools and workflow controller; no copied donor engine or second workflow writer.
- Shell-free native launch from a fixed repository working directory, preserving native user configuration while refusing explicit sandbox bypass, workspace expansion and remote-host redirection.
- Exact preservation of `glm-5.3`, `glm-5.3-flash`, and `glm-5.3-flash[1m]` on the explicit Z.AI route.
- Exclusive designated-result publication for issue #4 and bounded protected-ref attribution for issue #5.

## Compatibility matrix

| Surface          | Implemented path                                                                                                                                   | Authority and fallback                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code lead | Managed project plugin passed with `--plugin-dir`; installed OMC agents, skill, MCP pointer and hooks                                              | Shared core gates remain authoritative if hooks are disabled or unavailable.                                                          |
| Codex lead       | Trusted project config, repo marketplace, compatibility plugin, AGENTS.md, native agents, project hooks, fallback skill and direct OMC MCP pointer | Plugin discovery/install and exact hook trust are user/client state; shared CLI gates cover missing lifecycle callbacks.              |
| Host switching   | Repository-local supported-host config plus repository-keyed ignored selection and lease                                                           | A live lease, process, attempt or shared-workspace operation lock blocks switching.                                                   |
| Native resume    | Same repository, host, selection and previously recorded native session only                                                                       | Cross-repository, cross-host and stale session IDs are refused.                                                                       |
| Worker routing   | Existing explicit Claude, Codex and GLM provider bindings                                                                                          | Lead host selection never rewrites or infers provider bindings.                                                                       |
| Workflow state   | Existing OMC V1/V2 and V1.3-compatible records                                                                                                     | Historical records remain byte-stable on read; new provenance is additive.                                                            |
| OMX state        | No implicit import                                                                                                                                 | Simultaneous live ownership is refused; arbitrary OMX import is deferred until a separately specified transactional migration exists. |

## Verified and unverified environments

See the [verification record](WORKFLOW-V1.4-VERIFICATION.md) for exact local results, platform limits and release gates.

The development environment used Codex CLI `0.155.0-alpha.9` and Claude Code `2.1.272` on Windows. Local parser/help/MCP and generated-asset smoke checks do not prove a live authenticated model call. Codex plugin installation/refresh, exact hook trust, hosted-tool hook delivery, provider credentials and model availability require separate authenticated evidence. Linux CI and macOS POSIX/tmux results must be reported from jobs that actually ran; a configured workflow is not a pass.

Codex reports the `hooks` and `plugins` features as stable in the checked CLI. `plugin_hooks` is removed in that build, so this release uses the current plugin manifest/hook surface and does not infer support from the removed feature name. Codex project configuration loads only for a trusted project. Plugin-bundled hooks remain untrusted until the user accepts the exact definition, and `SessionEnd` is advisory. Hosted tools can bypass local tool hooks.

Existing OMC notification launch options remain shared across both adopted hosts. Permission-bypass aliases such as `--madmax` and `--yolo` are refused, as are alternate remote, cloud, attach, teleport, background, safe and bare modes and native app/session-service entry points. Continuation is supported only through `omc launch --resume` with a native session recorded for the current host and selection. Native user/profile permissions, readable roots and network settings still apply; OMC's workflow gates independently enforce task write scopes and state ownership.

## Setup safety and rollback

Project setup runs asset changes and shared-host configuration under the repository operation gate. It preflights owned targets, creates backups, writes an ownership receipt, and compensates all applied mutations if setup or config publication fails. Update uses the same idempotent path. Uninstall verifies hashes or exact managed content and preserves anything the user changed. It cannot remove the active or final host.

The setup-owned `.gitignore` block excludes only local `.omc/state/` and `.omc/hosts/` data. A fresh repository leaves `.omc/orchestrator.json` visible for sharing. Existing broader user ignore rules are preserved; repositories that already ignore all of `.omc` can deliberately stage the declaration with `git add -f .omc/orchestrator.json`.

With `OMC_STATE_DIR` or a parent `.omc-workspace`, the runtime anchor may be shared while configuration, assets and launch cwd remain in each physical Git checkout. Repository-keyed runtime and session records isolate sibling host selections; the common operation lock continues to serialize shared workflow mutations.

The core operation lock is fail closed and never auto-reaped. After a crash, manual lock removal is allowed only for the exact effective `state/orchestrator/operation.lock`, after the recorded PID and all provider processes are confirmed dead and the workflow is quiescent; `omc orchestrator recover` must then record the recovery boundary. Broad state deletion is unsupported.

## Donor boundary

Donor `kachiuli/oh-my-codex` 0.21.5 at [`cb955b0d`](https://github.com/kachiuli/oh-my-codex/tree/cb955b0d5becbef76d2c1f0096b6e1f238e1e7f7) supplied read-only evidence for project packaging, paths and host integration. Workflow V1.4 adapted the thin host surface. It did not copy the donor workflow engine, state schema, provider registry, role catalog, Rust harnesses, sparkshell, wiki, HUD variants or notification system.

## Migration

No migration is required for existing OMC workflow state or for repositories that keep the legacy Claude-only launch. Project adoption is explicit with `omc setup --host ... --scope project`. OMX workflow schemas are incompatible and are not guessed, partially imported or co-written. Finish live OMX work in OMX before adopting OMC for that workflow.

Primary compatibility sources are [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-advanced), [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Codex plugin packaging](https://developers.openai.com/plugins/build/plugins), [Claude plugins](https://code.claude.com/docs/en/plugins), [Claude hooks](https://code.claude.com/docs/en/hooks), [Z.AI GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3), and [Z.AI GLM-5.3 Flash](https://docs.z.ai/guides/vlm/glm-5.3-flash).
