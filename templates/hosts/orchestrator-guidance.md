# OMC repository orchestration

This repository uses OMC's shared workflow controller. The native Claude Code or Codex session is the lead interface; provider and model bindings for implementers and reviewers remain independent.

- Read `.omc/orchestrator.json` and run `omc orchestrator status` before starting or resuming orchestration work.
- Use `omc team workflow` commands for workflow mutations. Publish a worker result only with `omc team workflow publish-result --source <file> --result-file <designated-absolute-path> --task-id <id>`.
- Switch leads only at a quiescent checkpoint with `omc orchestrator use` or `omc orchestrator handoff`. A host switch starts a fresh native session and keeps the shared OMC checkpoint.
- Treat the OMC CLI operation gate and lease as authoritative. Native lifecycle hooks provide session checks and context; they do not replace core mutation gates.
- Follow the hook guidance from `omc doctor hosts`: supported Codex versions require project trust and definition review with `/hooks`; unsupported versions need an upgrade. Diagnostics never approve hooks or establish native trust.
- Keep provider identity explicit. Preserve exact model identifiers, including `glm-5.3`, `glm-5.3-flash`, and `glm-5.3-flash[1m]`; do not infer a provider from a model-name substring.
- Do not run an OMX writer against `.omc` workflows or guess a migration between OMX and OMC state. Finish live OMX work in OMX before adopting this controller.
- Use the installed `omc-orchestration` skill and native role agents for operating details. Run `omc doctor hosts` when host assets, hooks, MCP, or CLI availability are uncertain.
