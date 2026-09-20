English | [한국어](README.ko.md) | [中文](README.zh.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Tiếng Việt](README.vi.md) | [Português](README.pt.md)

# oh-my-claudecode

**Personal fork:** I maintain this fork of [Yeachan Heo's oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) for my own Claude-led development workflow with GLM workers and Codex review. [Why this fork exists](#why-i-maintain-this-fork) · [Set it up](#glm-workflow-v1-fork-setup) · [V1.1 local efficiency](#v11-local-efficiency) · [V1.2 role substitution candidate](docs/GLM-WORKFLOW-V1.2.md). The upstream project, authors and community links are credited below.

[![npm version](https://img.shields.io/npm/v/oh-my-claude-sisyphus?color=cb3837)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-claude-sisyphus?color=blue)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![GitHub stars](https://img.shields.io/github/stars/Yeachan-Heo/oh-my-claudecode?style=flat&color=yellow)](https://github.com/Yeachan-Heo/oh-my-claudecode/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Sponsor](https://img.shields.io/badge/Sponsor-❤️-red?style=flat&logo=github)](https://github.com/sponsors/Yeachan-Heo)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/wSyUQYfhAw)

> **workflow-v1.4 candidate:** This fork can use Claude Code or Codex as the repository's OMC lead, with independent Claude, Codex, GLM, and GLM Flash worker/reviewer bindings. See the [project setup and switching guide](docs/WORKFLOW-V1.4.md) and [release notes and verification limits](docs/WORKFLOW-V1.4-RELEASE-NOTES.md). Codex integration adapts selected capabilities from [oh-my-codex](https://github.com/kachiuli/oh-my-codex).

> **Liked OmC but found it a bit overkill? Try [gajae-code](https://github.com/Yeachan-Heo/gajae-code).**
> Keeps Claude OAuth as-is while being faster, cheaper, simpler, and more powerful — with an SDK-based integration path built for OpenClaw, Hermes, Grokbot, and similar agent runtimes.

**Multi-agent orchestration for Claude Code. Zero learning curve.**

_Don't learn Claude Code. Just use OMC._

**Fork opt-in workflow:** [Set up Claude planning, isolated GLM workers, and Codex review](#glm-workflow-v1-fork-setup). Includes installation, first-run instructions, limitations, and recovery steps. Existing OMC defaults remain unchanged.

[My Use Case](#why-i-maintain-this-fork) • [GLM Setup](#glm-workflow-v1-fork-setup) • [Upstream Quick Start](#quick-start) • [Documentation](https://yeachan-heo.github.io/oh-my-claudecode-website) • [CLI Reference](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#cli-reference) • [Workflows](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#workflows) • [Migration Guide](docs/MIGRATION.md) • [Discord](https://discord.gg/wSyUQYfhAw)

---

## Why I maintain this fork

I want to use my Claude subscription through Claude Code to lead work on my actual projects: understand the problem, plan the change, make architecture decisions and decide what is ready to integrate. I want GLM to handle routine implementation in parallel, while Codex provides an independent final review.

My aim is to keep Claude's context and quota focused on decisions. Workers should return a small result, test evidence and a commit, so the lead can inspect relevant changes without reading every worker's full conversation.

My intended workflow is:

1. **Claude plans the work.** The lead splits a feature into clear tasks, assigns ownership of files and defines the interfaces and tests before implementation starts.
2. **Three or four GLM workers implement it.** Each task gets a fresh process, a separate Git worktree and a defined scope. Workers return concise results and commits instead of merging their own work.
3. **Claude accepts and checks the changes.** The lead inspects the results, explicitly integrates accepted commits onto a dedicated branch and runs local tests and other deterministic checks.
4. **Codex reviews independently.** After those checks pass, Codex performs a read-only review of the integrated code against the requirements, without receiving GLM transcripts.
5. **Claude decides which findings need action.** The lead validates findings, sends valid fixes back to GLM and checks the resulting changes. The default limit is an initial review plus one re-review, with no endless review loop.
6. **I publish a coherent result.** I decide when to merge or push the integration branch and run remote CI, rather than triggering that process for every worker commit.

This is the personal workflow V1 is intended to support; live provider authentication and the full setup still need validation. Start with the [setup and first-run guide below](#glm-workflow-v1-fork-setup) and read the [current verification limits](docs/GLM-WORKFLOW-VALIDATION.md). Existing OMC defaults remain available; persistent worker sessions and distributed execution are outside V1.

V1.1 adds an optional balanced mode for this same use case: reusable project context, measured token/cache usage and explicit continuation of a failed task in its original worktree. The aim is to reduce repeated discovery while preserving the information and checks needed for good work. It does not lower model capability or remove review to make the token count look smaller. Give another project the [V1 adoption prompt](docs/GLM-WORKFLOW-V1-HANDOFF.md) if it should stay on the existing V1 baseline.

## Core Maintainers

| Role           | Name        | GitHub                                         |
| -------------- | ----------- | ---------------------------------------------- |
| Creator & Lead | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |

## Ambassadors

| Name       | GitHub                                           |
| ---------- | ------------------------------------------------ |
| Sigrid Jin | [@sigridjineth](https://github.com/sigridjineth) |

## Document Specialists

| Name    | GitHub                                 |
| ------- | -------------------------------------- |
| devswha | [@devswha](https://github.com/devswha) |

## Top Collaborators

| Name           | GitHub                                         | Commits |
| -------------- | ---------------------------------------------- | ------- |
| JunghwanNA     | [@shaun0927](https://github.com/shaun0927)     | 65      |
| riftzen-bit    | [@riftzen-bit](https://github.com/riftzen-bit) | 52      |
| Seunggwan Song | [@Nathan-Song](https://github.com/Nathan-Song) | 20      |
| BLUE           | [@blue-int](https://github.com/blue-int)       | 20      |
| Junho Yeo      | [@junhoyeo](https://github.com/junhoyeo)       | 15      |

## Quick Start

For this fork's GLM additions, use the [GLM setup below](#glm-workflow-v1-fork-setup); the upstream marketplace and published npm package do not contain these unpublished changes.

**Step 1: Install**

Marketplace/plugin install (recommended for most Claude Code users).
These are Claude Code slash commands — enter them **one at a time** (pasting both lines at once will fail):

```bash
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
```

Then:

```bash
/plugin install oh-my-claudecode
```

If you prefer the npm CLI/runtime path instead of the marketplace flow:

```bash
npm i -g oh-my-claude-sisyphus@latest
```

> **Known npm warning:** npm may print `deprecated prebuild-install@7.1.3` during the CLI install.
> This currently comes from the upstream `better-sqlite3` native-addon dependency
> (`better-sqlite3 -> prebuild-install`); `prebuild-install@7.1.3` is still the latest
> published version, so there is no safe repo-side dependency bump or override to remove
> the warning yet. The warning is tracked in [#2913](https://github.com/Yeachan-Heo/oh-my-claudecode/issues/2913)
> and does not by itself mean the OMC CLI install failed.

**Step 2: Setup**

```bash
# Inside a Claude Code / OMC session
/omc-setup

# From your terminal
omc setup
```

If you run OMC via `omc --plugin-dir <path>` or `claude --plugin-dir <path>`, add `--plugin-dir-mode` to `omc setup` (or export `OMC_PLUGIN_ROOT` before running it) so the installer doesn't duplicate skills/agents that the plugin already provides at runtime. See the [Plugin directory flags section in REFERENCE.md](./docs/REFERENCE.md#plugin-directory-flags) for a complete decision matrix and all available flags.

**Step 3: Build something**

```bash
# Inside a Claude Code / OMC session
/autopilot "build a REST API for managing tasks"

# Natural-language in-session shortcut
autopilot: build a REST API for managing tasks
```

#### Named autopilot stage profiles (v1)

Select a configured stage profile only through `/autopilot --workflow <name> <task>`:

```text
/autopilot --workflow plan-build-qa "build a REST API for managing tasks"
```

Profiles are configured under `autopilot.workflows` in `.claude/omc.jsonc` (project) or `~/.config/claude-omc/config.jsonc` (user). A v1 profile contains only `version: 1` and `stages`:

```jsonc
{
  "autopilot": {
    "workflows": {
      "plan-build-qa": {
        "version": 1,
        "stages": ["ralplan", "execution", "qa"]
      }
    }
  }
}
```

The admitted sequences are `[ralplan, execution]`, `[ralplan, execution, ralph]`, `[ralplan, execution, qa]`, and `[ralplan, execution, ralph, qa]`. A project profile of the same name wholly replaces the user profile; different names coexist. Environment variables cannot define profiles. Profiles remain within autopilot's existing state, cancel, resume, Stop, and HUD lifecycle; legacy invocations without `--workflow` remain compatible.

Named profiles currently require Linux with the `flock` utility because their transcript evidence boundary uses Linux no-follow file-descriptor traversal and their recoverable mutation lock uses kernel advisory locking. Unsupported environments reject explicit `--workflow` invocation before creating or changing autopilot state; legacy autopilot remains available.

V1 intentionally excludes model fields or routing (`stageModels`), inline execution, dynamic commands/modes/state, arbitrary stages or plugins, and the separate custom-skill frontmatter parser mismatch. See [Named Autopilot Stage Profiles ADR](docs/adr/03487-named-autopilot-stage-profiles.md) and [Reference](docs/REFERENCE.md#named-autopilot-stage-profiles-v1).


That's it. Everything else is automatic.

### CLI Commands vs In-Session Skills

OMC exposes two different surfaces:

- **Terminal CLI commands**: run `omc ...` from your shell after installing the npm/runtime path (`npm i -g oh-my-claude-sisyphus@latest`) or from a local checkout.
- **In-session skills**: run `/...` inside a Claude Code session after installing the plugin/setup flow.

| Feature                                        | Terminal CLI                                  | In-session skill                                                        | Notes                                                                                                                                |
| ---------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Setup                                          | `omc setup`                                   | `/omc-setup`                                                            | Both are real entrypoints.                                                                                                            |
| Ask providers                                  | `omc ask codex "review this patch"`           | `/ask codex "review this patch"`                                        | Both route through the same advisor flow. Providers: `claude`, `codex`, `gemini`, `antigravity`, `grok`, `cursor`; this fork also adds `glm`.                                            |
| Team orchestration                             | `omc team 2:codex "review auth flow"`         | `/team 3:executor "fix all TypeScript errors"`                          | Both exist, but they are different runtimes: `omc team` launches tmux CLI workers; `/team` runs the in-session native team workflow. |
| Claude/GLM/Codex workflow (this fork)            | `omc team workflow init --file .omc/plans/feature-x.json` | Claude lead invokes the terminal operations                       | Explicit scoped plan, worker acceptance, verification, review and remediation gates. See [setup](#glm-workflow-v1-fork-setup). |
| Pre-flight danger scan                         | `omc lookout scan --brief "..." [--json] [--strict]` | —                                                                | Advisory only: scans the task briefing and workspace before an unattended run and reports danger findings (findings/severity contract). Exit codes: 0 for successful non-strict scans (and strict scans without high-risk signals), 1 `--strict` with high-risk signals, 2 usage/scan error. |
| Autopilot / Ralph / Execute / Deep Interview   | —                                             | `/autopilot ...`, `/ralph ...`, `/execute ...`, `/deep-interview ...`   | These are in-session skills. There is no `omc autopilot` / `omc ralph` / `omc execute` CLI subcommand in this repo.                  |
| Autoresearch                                   | `omc autoresearch` (**hard-deprecated shim**) | `/deep-interview --autoresearch ...` + `/oh-my-claudecode:autoresearch` | Setup stays in deep-interview; execution now belongs to the stateful skill.                                                          |

### VS Code, Agent SDK, and automation scope

- **VS Code / IDE extension**: OMC does not ship a VS Code extension and does not document extension-specific install or automation flows. Use the Claude Code plugin or terminal CLI surfaces above; IDE integrations are only an optional way to access Claude Code itself.
- **Agent SDK / programmatic usage**: the npm package exports TypeScript helpers such as `createOmcSession()` and prompt expansion utilities for local Node.js programs using `@anthropic-ai/claude-agent-sdk`. This is a library surface, not a replacement for the Claude Code plugin UI.
- **CI/CD and headless automation**: prefer deterministic terminal commands (`omc setup`, `omc ask`, `omc session search`, repository scripts such as `npm run sync-metadata:verify`) and set `ANTHROPIC_API_KEY` or provider-specific CLI auth in the runner environment. Do not rely on interactive slash commands (`/autopilot`, `/ralph`, `/execute`, `/team`) in CI; they require an active Claude Code session.

### Not Sure Where to Start?

If you're uncertain about requirements, have a vague idea, or want to micromanage the design:

```
/deep-interview "I want to build a task management app"
```

The deep interview uses Socratic questioning to clarify your thinking before any code is written. It exposes hidden assumptions and measures clarity across weighted dimensions, ensuring you know exactly what to build before execution begins.

## GLM workflow V1: fork setup

**V1.2 local candidate:** [Explicit role substitution and reusable private setup](docs/GLM-WORKFLOW-V1.2.md)
adds normal Claude implementation/review and records an external Claude or Astra
lead. Self-review is allowed and labelled honestly. Integrated local checks and
[bounded live Claude worker/review checks pass](docs/GLM-WORKFLOW-V1.2-VALIDATION.md);
effective read-only enforcement evidence remains partial.
Use the exact adopted source checkout and absolute built CLI; this is not an npm
release. The V1/V1.1 walkthrough below keeps its historical defaults.

This opt-in workflow keeps **Claude as the lead**, runs **GLM implementation workers in separate Git worktrees**, and asks **Codex for independent review**. Claude supplies the plan, accepts commits and decides what to do with review findings. The controller does not start a Claude lead for you.

**Current readiness:** suitable for a controlled trial, starting in a separate clone of your project. See the [validation report](docs/GLM-WORKFLOW-VALIDATION.md) for exact test results, independent-review fixes and remaining limits. Actual authenticated GLM/Codex execution has not been tested. The broader Windows test suite has failures; some match upstream, and others remain unclassified.

You will configure three commands, each with its own provider access:

| Command | Account / configuration | Job |
| --- | --- | --- |
| `claude` | Your normal Claude Code profile and Anthropic access | Lead: plan, inspect and integrate |
| `claude-glm` | A second Claude Code profile with your Z.AI key | GLM workers: implement scoped tasks |
| `codex` | Your Codex CLI sign-in | Independently review integrated changes |

Claude and GLM use the **same Claude Code executable with different settings**. You do not switch the lead to GLM. OMC starts GLM processes through the wrapper and starts Codex when the lead invokes the review operation.

### 0. Choose one environment

The commands below use **Bash on Linux, macOS or WSL2**. For Windows, use an Ubuntu WSL2 terminal for this walkthrough. If needed, run `wsl --install -d Ubuntu` from an administrator PowerShell window, restart when requested, then open Ubuntu and complete its first-run user setup. See [Microsoft's WSL installation guide](https://learn.microsoft.com/en-us/windows/wsl/install).

Install Git, Node.js 22 or 24 with npm, Claude Code, Codex and this fork **inside that same environment**. Keep the trial repositories there too, for example under `~/dev`. Windows installations and logins do not automatically provide the Linux commands or credentials. Native Windows requires a custom executable GLM wrapper; this fork does not ship one, so the Bash instructions are the complete example here.

Before the provider checks in steps 2–5, make a separate clone of the project you want to change and use it as your trial directory. Commit any work you need to carry over before cloning; uncommitted changes are not copied. Keep this trial clone separate from the OMC source checkout.

### 1. Build and select this fork

Use the checkout containing the `codex/glm-workflow-v1` changes. These additions have not been published to npm; installing the upstream package or plugin alone will not enable them. If you do not have the fork yet:

```bash
mkdir -p "$HOME/dev"
cd "$HOME/dev"
git clone --branch codex/glm-workflow-v1 https://github.com/kachiuli/oh-my-claudecode.git
cd oh-my-claudecode
```

Run from this fork's checkout:

```bash
npm ci
npm run build
node bridge/cli.cjs team workflow --help
```

To use the `omc` commands below from your project directory, you can then run `npm link` from the fork checkout. This changes the globally linked OMC command to this checkout; rebuilding here updates the code it runs. Check `omc team workflow --help` before proceeding.

If you prefer a local invocation, replace `omc` in every command below with `node` and the absolute path to this checkout's `bridge/cli.cjs`. For example, on Windows:

```powershell
node C:/dev/oh-my-claudecode/bridge/cli.cjs team workflow --help
```

Give Claude the same absolute CLI path if its shell uses a different OMC installation. Run workflow commands from the **project you want to change**, not from the OMC source checkout.

### 2. Set up the normal Claude lead

Install Claude Code if it is missing, using [Anthropic's installation instructions](https://code.claude.com/docs/en/setup). The native installer for Bash is:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Open a fresh terminal if needed so `claude` is on PATH. From your trial project directory, run `claude --version`, then `claude` and complete the sign-in prompts with your normal Claude account or Anthropic access. In that session, use `/status` to inspect the connection and send a small prompt. This is your lead. See [Claude Code authentication](https://code.claude.com/docs/en/authentication) for available sign-in methods.

Keep GLM endpoint/key/model settings out of the normal `~/.claude/settings.json`, the project's `.claude/settings.json` and `.claude/settings.local.json`, and global shell exports. Also keep `CLAUDE_CONFIG_DIR` unset in the lead's terminal. If an earlier GLM helper changed these locations, remove or restore just those provider overrides before starting the lead; keep your other settings. Project settings still apply to both profiles and can override their user settings. [Settings precedence](https://code.claude.com/docs/en/settings).

### 3. Create the GLM profile and wrapper

Create a Z.AI API key with access to the GLM Coding Plan, following [Z.AI's Claude Code guide](https://docs.z.ai/devpack/tool/claude). Create the separate profile directory:

```bash
mkdir -p "$HOME/.claude-glm" "$HOME/.local/bin"
chmod 700 "$HOME/.claude-glm"
```

Use a local editor to create **`~/.claude-glm/settings.json`** with this content. Replace `YOUR_ZAI_API_KEY` locally. The model IDs below are examples from Z.AI's guide checked on 2026-09-12; use IDs available to your plan if they differ. `model: "sonnet"` selects the GLM mapping below when you launch the wrapper interactively.

```json
{
  "model": "sonnet",
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "YOUR_ZAI_API_KEY",
    "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.3[1m]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.3[1m]",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-5.3-flash[1m]"
  }
}
```

Keep this file outside your repository and restrict it with `chmod 600 "$HOME/.claude-glm/settings.json"`. Do not put the key in OMC configuration, a plan, a prompt or a commit. Do not copy the lead's credentials into the GLM profile or run a helper that overwrites the default profile.

Save the following as **`~/.local/bin/claude-glm`**, with Unix (LF) line endings:

```bash
#!/usr/bin/env bash
set -euo pipefail
unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_MODEL
unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY
export CLAUDE_CONFIG_DIR="$HOME/.claude-glm"
exec claude "$@"
```

The wrapper selects the GLM profile only for its own process and forwards every argument. It clears conflicting inherited auth/provider choices; project or managed provider overrides must still be resolved in the settings that define them. [Claude environment precedence](https://code.claude.com/docs/en/env-vars).

```bash
chmod +x "$HOME/.local/bin/claude-glm"
export PATH="$HOME/.local/bin:$PATH"
command -v claude claude-glm
```

Add the same PATH export to your shell startup file if it is not already there. From the trial project, run `claude-glm` once interactively, complete any onboarding/trust prompts, accept the configured API key if asked, and inspect `/status`. Send a small prompt and confirm the model/endpoint against your GLM settings or Z.AI usage. A model's self-description alone does not verify its provider. Exit that session, then confirm ordinary `claude` still uses your Anthropic connection. You can run the two commands in separate terminals at the same time.

**Native Windows:** this launch path requires a directly executable wrapper, such as an `.exe`. `.cmd`, `.bat` and `.ps1` wrappers are rejected because OMC launches GLM without a shell. The Bash wrapper above is for a POSIX environment; it is not a PowerShell script. A trusted local wrapper must select your GLM profile and forward Claude CLI arguments.

### 4. Install and sign in to Codex

Install the **Codex CLI** in the same environment as the lead and OMC. The Bash installer below follows [OpenAI's Codex CLI guide](https://learn.chatgpt.com/docs/codex/cli):

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

Open a fresh terminal if the installer requests it, then:

```bash
codex --version
codex login
codex login status
codex exec --help
```

`codex login` opens the ChatGPT sign-in flow. If the browser callback cannot reach your WSL/remote terminal, `codex login --device-auth` is an option when device-code login is enabled for your account or workspace. API-key users can instead pipe an already configured key through stdin with `printenv OPENAI_API_KEY | codex login --with-api-key`; this uses OpenAI API billing. Never paste credentials into the repository. See [OpenAI's authentication guide](https://learn.chatgpt.com/docs/auth).

Run `codex` in the trial repository and use `/model` to select an available model. Note its exact model ID for `codexModel` in the OMC configuration below; **OMC passes an explicit review model**, so changing only Codex's own default is insufficient. Desktop or editor sign-in alone is not the check: `codex login status` must work in the environment that runs the workflow. The CLI must support `exec`, `--sandbox read-only`, `--ephemeral`, `--output-schema` and `--output-last-message`. [Codex command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

### 5. Enable the routing profile

Add or merge this configuration into **`~/.config/claude-omc/config.jsonc`** for your Linux/macOS/WSL user (`$XDG_CONFIG_HOME/claude-omc/config.jsonc` when set), or **`.claude/omc.jsonc`** for the target project. Native Windows uses **`%APPDATA%/claude-omc/config.jsonc`** for user configuration. Create the parent directory if needed. These are OMC routing files; they are separate from Claude Code's `settings.json`.

Replace `YOUR_CODEX_MODEL_ID` with the ID you checked in Codex. Set `glmModel` to the GLM model you verified in step 3:

```json
{
  "team": {
    "profile": "claude-glm-codex",
    "glm": {
      "command": "claude-glm",
      "fallback": false,
      "defaultWorkers": 4,
      "maxWorkers": 6
    }
  },
  "externalModels": {
    "defaults": {
      "glmModel": "glm-5.3[1m]",
      "codexModel": "YOUR_CODEX_MODEL_ID"
    }
  }
}
```

`command` is one executable name on PATH or an absolute executable path, with no arguments appended. `OMC_GLM_COMMAND` overrides it. Omit model settings to use your wrapper's default; to choose a model, set `externalModels.defaults.glmModel` to a model ID supported by your plan. `OMC_EXTERNAL_MODELS_DEFAULT_GLM_MODEL` overrides that value.

The profile routes planner/architect to Claude HIGH, executor/debugger/test-engineer to GLM, and critic/code-reviewer to Codex. Explicit per-role settings retain precedence; the strict workflow rejects an executor other than GLM or reviewer other than Codex. Keep Claude specialist use focused on architecture or difficult decisions; routine implementation belongs to GLM.

The default is **4 concurrent workers**, with a configured ceiling of **6**. These are local OMC limits, not a promise about subscription capacity; excess assignments wait in the queue. V1 requires `fallback: false`: a missing GLM executable fails instead of silently switching to Claude. `fallback: true` is rejected.

```text
omc doctor --team-routing
omc ask glm "Reply with a short confirmation. Do not modify files."
```

Doctor checks configuration and executable availability, not authentication or which endpoint your wrapper uses. The small `ask` is a live provider call and consumes quota. From the same trial repository, test Codex with the **same model ID** you put in OMC:

```bash
codex exec --sandbox read-only --ephemeral --model YOUR_CODEX_MODEL_ID "Reply with a short confirmation. Do not modify files."
```

Proceed when the normal Claude lead, GLM wrapper and Codex each work. These prompts consume provider quota; they check connectivity, not the complete orchestration. This fork does not need Codex registered as a Claude MCP server: the workflow calls its CLI directly. The setup commands here were checked against official docs and local CLI help; authenticated provider setup has not been run as part of this fork's validation.

### 6. Start orchestration from the Claude lead

Use the separate project clone you checked above. Begin with a small change and clear tests. Keep the checkout clean: use user-level OMC configuration, or commit/ignore intended project configuration before capturing the base commit. Save your plan as `.omc/plans/feature-x.json`; untracked `.omc` artifacts are allowed. An untracked root-level `plan.json` or `.claude/omc.jsonc` can otherwise block startup.

Give the Claude lead your feature request and the absolute path to this fork's `docs/GLM-WORKFLOW.md`. Ask it to prepare a plan using the [complete plan schema and example](docs/GLM-WORKFLOW.md#prepare-a-scoped-plan) and invoke the workflow commands through the fork's CLI. Give each task an objective, current base commit, owned files, prohibited files, dependencies, contracts, acceptance criteria and executable test commands. Independent workers need separate write scopes; order overlapping tasks with dependencies. Choose a dedicated integration branch, not `main` or `master`.

Start **`claude`**, then paste this prompt after replacing both paths and the feature description:

```text
You are the Claude lead for my personal Claude → GLM → Codex workflow.
Read /absolute/path/to/oh-my-claudecode/docs/GLM-WORKFLOW.md.
Use node /absolute/path/to/oh-my-claudecode/bridge/cli.cjs for OMC commands,
with this project's clone as the working directory.

Feature: [describe one small change and how to verify it].

Inspect the project and create a scoped plan under .omc/plans with its current
base commit, separate worker ownership and real test commands. Use the strict
team workflow operations: initialize, run GLM workers, inspect their commits,
accept or reject them, and verify accepted changes. After verification, ask Codex
for independent review. Assess its findings, dispatch scoped GLM fixes where
needed, and re-verify within the review budget. Keep me informed of failures.
Report the final diff and checks. Do not merge into main or push automatically.
```

The commands below are the operations the lead invokes; you can also use them manually to inspect or recover the run. Starting `claude-glm` yourself only opens a GLM session. Starting the normal lead with this request connects the planning, workers, integration and review process.

Fresh worktrees do not automatically receive ignored dependencies or local `.env` files. Include the required dependency setup and test prerequisites in the task, using the project's existing lockfile and tools. Keep credentials out of the plan.

The following examples use plan name `feature-x` and task ID `backend`. Replace them with your plan's values. The `init` command reads the saved plan and creates the integration branch; run all subsequent operations from that same clone.

```text
omc team workflow init --file .omc/plans/feature-x.json --workers 4
omc team workflow run feature-x
omc team workflow status feature-x
```

Test commands in the plan use executable/argument arrays without shell expansion. On Windows, use a directly executable command such as `node` plus a script path rather than a shell-only npm shim.

Workers must produce one coherent commit. The lead inspects each result and diff, then explicitly accepts or rejects it:

```text
omc team workflow accept feature-x backend
omc team workflow reject feature-x unwanted-task --reason "Outside the agreed scope"
```

These illustrate separate decisions; only use `reject` for an actual task you intend to reject. Only accepted commits are integrated. Run again after accepting dependencies to dispatch newly ready tasks. Once intended work is integrated, run deterministic checks before Codex review:

```text
omc team workflow verify feature-x
omc team workflow review feature-x
```

Codex review requests a **read-only sandbox** and receives the task requirements and integrated changes, without GLM transcripts. Claude must inspect the findings and record `fix` or `dismiss` decisions with reasons. If findings require changes, prepare the [decision and fix files](docs/GLM-WORKFLOW.md#independent-review-and-bounded-remediation), then:

```text
omc team workflow adjudicate feature-x --file .omc/plans/decisions.json
omc team workflow add-fix feature-x --file .omc/plans/fix.json
omc team workflow run feature-x
omc team workflow accept feature-x fix-backend
omc team workflow verify feature-x
omc team workflow review feature-x
```

Replace `fix-backend` with the fix task's ID. Dismissed findings need recorded reasons but no fix task; a clean review needs no remediation.

The default budget is **2 review passes total**: the initial review and at most one re-review. Failed review attempts also consume a pass. Unresolved accepted findings or an exhausted budget do not automatically become success. After the gates pass:

```text
omc team workflow finish feature-x
omc team workflow cleanup feature-x
```

Cleanup removes only clean, accepted worktrees after completion; it retains dirty or rejected work and the workflow ledger. Review the final diff and your project's test results before merging or pushing. The workflow does not automatically push worker commits or wait for remote CI.

**Which team command should I use?** `omc team 4:glm "task"` launches ordinary GLM team panes and requires tmux/psmux plus runtime-v2. It does not enforce the complete plan, acceptance and review process above. Use **`omc team workflow`** for that process; its local process controller does not require tmux.

**Worker permissions:** GLM workers launch with `--dangerously-skip-permissions`. Use a trusted wrapper: worktrees separate Git work but do not sandbox filesystem or network access. Scope and branch checks reject invalid results after execution; they do not prevent every out-of-scope action. Keep the first trial in a separate clone with only the access it needs.

### 7. Inspect results and report bugs

`omc team workflow status feature-x` returns concise task status, commits, test summaries, risks and artifact paths. Normal status is capped at 16 KiB and identifies omitted entries; follow the returned state/artifact paths for complete evidence. Full worker logs are not automatically sent to the lead.

If a command fails, interrupt an active run if needed and **preserve the worktrees and `.omc` files**. Do not force-delete dirty work or repeatedly rerun an interrupted task. V1 starts fresh worker processes and does not automatically resume timed-out or interrupted assignments. Inspect preserved changes before beginning a new scoped workflow.

For a bug report, include the fork commit (`git rev-parse HEAD` in the OMC checkout), operating system, exact command, expected result, error message and workflow status. Include only relevant artifact excerpts, with credentials removed. Check [troubleshooting](docs/GLM-WORKFLOW.md#troubleshooting) for missing wrappers, scope failures, stale verification and exhausted review budgets.

For the full contract and command walkthrough, read the [GLM workflow guide](docs/GLM-WORKFLOW.md). The [validation report](docs/GLM-WORKFLOW-VALIDATION.md) lists tested behavior and remaining limitations; the [V2 roadmap](docs/GLM-WORKFLOW-V2.md) records deferred features.

### V1.1 local efficiency

V1 remains on [`codex/glm-workflow-v1`](https://github.com/kachiuli/oh-my-claudecode/tree/codex/glm-workflow-v1), pinned at `3e51fcf70545c2bc3ee5a24a9f11844e8a294c57`. V1.1 is on [`codex/glm-workflow-v1.1`](https://github.com/kachiuli/oh-my-claudecode/tree/codex/glm-workflow-v1.1). These are personal workflow revisions; the upstream package version remains 5.4.0, and neither fork revision is published to npm.

Keep your V1 installation available while trying V1.1. After completing the Claude, separate GLM profile and Codex setup above, build a second checkout:

```bash
cd "$HOME/dev"
git clone --branch codex/glm-workflow-v1.1 https://github.com/kachiuli/oh-my-claudecode.git oh-my-claudecode-v1.1
cd oh-my-claudecode-v1.1
npm ci
npm run build
node bridge/cli.cjs team workflow --help
```

From the **trial project**, invoke that checkout explicitly. Create a new plan and unused integration branch as described above, then:

```bash
node "$HOME/dev/oh-my-claudecode-v1.1/bridge/cli.cjs" team workflow init --file .omc/plans/feature-x.json --mode balanced --workers 4
node "$HOME/dev/oh-my-claudecode-v1.1/bridge/cli.cjs" team workflow run feature-x
node "$HOME/dev/oh-my-claudecode-v1.1/bridge/cli.cjs" team workflow usage feature-x
```

Use that same absolute CLI path for acceptance, verification, review and all other operations. Omitting `--mode balanced` retains V1 behavior. Existing saved V1 workflows stay in V1 mode; create a new workflow to try balanced mode.

An optional top-level `sharedContext` string in the plan can describe stable project architecture, terminology and testing conventions. Keep it under 16 KiB, omit credentials and changing progress notes, and continue supplying every task's complete scope, contracts, acceptance criteria and tests. Balanced prompts put this shared context before the assignment. Related tasks also receive concise results from accepted dependencies, with artifact references for detail. Each new task still gets its own worktree and conversation.

The `usage` report shows CLI-reported input, output, cache-read and cache-write tokens where available, including failed attempts and retries. Each counter includes measurement coverage. `null` means unknown; partial observations are not a complete bill. Input totals already include cached input, so do not add cache-read tokens again. Compare equivalent tasks using accepted results, test success, repair attempts and review findings as well as tokens. GLM subscription credits and Claude CLI price estimates are not interchangeable, and V1.1 does not claim a measured savings percentage.

Balanced mode requires Claude Code's `--session-id`, `--resume`, `--output-format stream-json` and `--verbose` flags through the wrapper, plus Codex `exec --json`. Check the local help before running; the wrapper must forward arguments unchanged and keep session persistence enabled. Provider event contracts were checked against Claude Code 2.1.258 and Codex CLI 0.153.4; authenticated execution still needs your smoke test. See the [V1.1 guide](docs/GLM-WORKFLOW.md#balanced-mode-v11) for session recovery and measurement limits, and the [V1.1 validation report](docs/GLM-WORKFLOW-V1.1-VALIDATION.md) for test evidence.

The quality gates stay the same: scoped ownership, one verified commit, explicit Claude acceptance, local tests, independent read-only Codex review and bounded remediation. Cache hits remain controlled by the provider. Separate worktrees and provider-generated prompts can reduce shared cache prefixes; a fresh process alone does not prove a cache miss. Cross-task conversation forks and distributed execution are deferred.

## Team Mode (Recommended)

Starting in **v4.1.7**, **Team** is the canonical orchestration surface in OMC. The legacy `swarm` keyword/skill has been removed; use `team` directly.

```bash
/team 3:executor "fix all TypeScript errors"
```

Use `/team ...` when you want Claude Code's in-session native team workflow. Use `omc team ...` when you want terminal-launched tmux CLI workers (`claude` / `codex` / `gemini` panes).

Team runs as a staged pipeline:

`team-plan → team-prd → team-exec → team-verify → team-fix (loop)`

Enable Claude Code native teams in `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

> If teams are disabled, OMC will warn you and fall back to non-team execution where possible.

### tmux CLI Workers — Codex, Gemini & Antigravity (v4.4.0+)

**v4.4.0 removes the Codex/Gemini MCP servers** (`x`, `g` providers). Use the CLI-first Team runtime (`omc team ...`) to spawn real tmux worker panes:

```bash
omc team 2:codex "review auth module for security issues"
omc team 2:gemini "redesign UI components for accessibility"
omc team 2:antigravity "redesign UI components for accessibility"
omc team 1:claude "implement the payment flow"
omc team 1:cursor "implement the payment flow"
omc team status auth-review
omc team shutdown auth-review
```

For mixed Codex + Antigravity work in one command, run `/ask codex` and `/ask antigravity` and have Claude synthesize the results (Gemini remains available as an enterprise/API-key fallback):

```bash
/ask codex "Review this PR — architecture"
/ask antigravity "Review this PR — UI components"
```

| Surface                         | Workers                       | Best For                                     |
| ------------------------------- | ----------------------------- | -------------------------------------------- |
| `omc team N:codex "..."`        | N Codex CLI panes             | Code review, security analysis, architecture |
| `omc team N:gemini "..."`       | N Gemini CLI panes            | UI/UX design, docs, large-context tasks (enterprise/API-key) |
| `omc team N:antigravity "..."`  | N Antigravity (`agy`) panes   | UI/UX design, docs, large-context tasks                      |
| `omc team N:grok "..."`         | N Grok Build CLI panes        | Code review, analysis cross-check            |
| `omc team N:cursor "..."`       | N Cursor agent panes          | Implementation and reviewer-style tasks      |
| `omc team N:claude "..."`       | N Claude CLI panes            | General tasks via Claude CLI in tmux         |
| `/ask codex` + `/ask antigravity` | Tri-model advisor synthesis | Mixed Codex + Antigravity review in one pass |

Workers spawn on-demand and die when their task completes — no idle resource usage. Requires the selected CLI (`codex`, `gemini`, `agy` (antigravity), `grok`, or `cursor-agent`) installed/authenticated and an active tmux session.

Autopilot can prefer Cursor executor workers during team execution via `.claude/omc.jsonc`:

```jsonc
{
  "autopilot": {
    "execution": "team",
    "team": { "agentTypes": ["cursor"] }
  }
}
```

This config makes the autopilot execution stage use `omc team 1:cursor "..."` or `/team 1:cursor "..."` for implementation work. Cursor also supports reviewer-style roles (`critic`, `code-reviewer`, `security-reviewer`, `test-engineer`): those workers emit the structured verdict file the team leader consumes to transition the task, and final approval stays a lead-session responsibility. Cursor requires an installed/authenticated `cursor-agent`.

Pin a Cursor model with the `OMC_EXTERNAL_MODELS_DEFAULT_CURSOR_MODEL` environment variable, or per role with `team.roleRouting.<role>.model`. `externalModels.defaults.cursorModel` applies to workers routed through `team.roleRouting`. Ids come from `cursor-agent --list-models`, for example `cursor-grok-4.6-high` or `composer-2.5`. Left unset, `cursor-agent` chooses its own model.

Native team worker worktrees are being added behind an opt-in/config gate. See [Native Team Worktree Mode](docs/TEAM-WORKTREE-MODE.md) for the workspace contract, canonical state-root rules, dirty-worktree preservation policy, and verification checklist.

> **Note: Package naming** — The project is branded as **oh-my-claudecode** (repo, plugin, commands), but the npm package is published as [`oh-my-claude-sisyphus`](https://www.npmjs.com/package/oh-my-claude-sisyphus). If you install or upgrade the CLI tools via npm/bun, use `npm i -g oh-my-claude-sisyphus@latest`; the package installs both `oh-my-claudecode` and the short `omc` command aliases.

### Updating

If you installed OMC via npm, upgrade with the published package name:

```bash
npm i -g oh-my-claude-sisyphus@latest
```

> **Package naming note:** the repo, plugin, and commands are branded **oh-my-claudecode**, but the published npm package name remains `oh-my-claude-sisyphus`. npm installs expose both `oh-my-claudecode` and `omc`; examples prefer `omc` for brevity.

If you installed OMC via the Claude Code marketplace/plugin flow, update with:

```bash
# 1. Update the marketplace clone
/plugin marketplace update omc

# 2. Re-run setup to refresh configuration
/omc-setup
```

If you are developing from a local checkout or git worktree, update the checkout first, then re-run setup from that worktree so the active runtime matches the code you are testing.

> **Note:** If marketplace auto-update is not enabled, you must manually run `/plugin marketplace update omc` to sync the latest version before running setup.

If you experience issues after updating, clear the old plugin cache:

```bash
/omc-doctor
```

<h1 align="center">Your Claude Just Have been Steroided.</h1>

<p align="center">
  <img src="assets/omc-character.jpg" alt="oh-my-claudecode" width="400" />
</p>

---

## Why oh-my-claudecode?

- **Zero configuration required** - Works out of the box with intelligent defaults
- **Team-first orchestration** - Team is the canonical multi-agent surface
- **Natural language interface** - No commands to memorize, just describe what you want
- **Automatic parallelization** - Complex tasks distributed across specialized agents
- **Persistent execution** - Won't give up until the job is verified complete
- **Cost optimization** - Smart model routing saves 30-50% on tokens
- **Learn from experience** - Automatically extracts and reuses problem-solving patterns
- **Real-time visibility** - HUD statusline shows what's happening under the hood

---

## Features

### Orchestration Modes

Multiple strategies for different use cases — from Team-backed orchestration to token-efficient refactoring. [Learn more →](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#execution-modes)

| Mode                        | What it is                                                                              | Use For                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Team (recommended)**      | Canonical staged pipeline (`team-plan → team-prd → team-exec → team-verify → team-fix`) | Coordinated Claude agents on a shared task list                         |
| **omc team (CLI)**          | tmux CLI workers — real `claude`/`codex`/`gemini`/`antigravity`/`grok`/`cursor-agent` processes in split-panes       | Codex/Gemini/Antigravity/Grok/Cursor CLI tasks; on-demand spawn, die when done             |
| **Tri-model advisor (`/ask codex` + `/ask antigravity`)** | Claude synthesizes both advisors' output                                 | Mixed backend+UI work needing both Codex and Antigravity                     |
| **Autopilot**               | Autonomous execution (single lead agent)                                                | End-to-end feature work with minimal ceremony                           |
| **Execute**                 | Persistent execution with verify/fix loops, from plan to working code                   | Tasks that must complete fully (no silent partials)                     |
| **Verify**                  | Evidence-based completion checks until tests/build/lint/typecheck goals pass            | Quality gates that need repeat diagnose/fix cycles                      |
| **Claude Code `/goal`**     | Native Claude Code cross-turn goal loop                                                 | One measurable session completion condition; not an OMC evidence ledger |
| **Artifact-only Ultragoal** | Durable goal/checkpoint/evidence artifacts without starting a loop                      | Handoffs, audits, or unavailable/conflicting loop runtimes              |

### Goal Workflow Guidance

Use only one primary loop authority in a session. Claude Code `/goal` is useful for a native cross-turn completion condition, while Execute owns single-agent verified completion, Team owns parallel staged execution, and Verify owns repeated quality-gate cycling. Artifact-only Ultragoal is the safe fallback when you need durable goal artifacts and evidence without starting another loop.

For `/goal` behavior, rely on Claude Code/Anthropic sources: the [Claude Code `/goal` docs](https://code.claude.com/docs/en/goal) and [Anthropic Claude Code changelog](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md). Do **not** claim the `/goal` evaluator independently runs commands or reads files; surface test output, diffs, and review evidence in the conversation before treating a goal as proven.

### Intelligent Orchestration

- **19 specialized agents** (with tier variants) for architecture, research, design, testing, data analysis
- **Smart model routing** - Haiku for simple tasks, Opus for complex reasoning
- **Automatic delegation** - Right agent for the job, every time
- **[Model × Agent Compatibility Matrix](docs/agents/model-compatibility.md)** - Which model to pair with each agent, with premium/balanced/budget presets

### Developer Experience

- **Prompt triggers** - `ralph`, `ralplan`; Team stays explicit via `/team`
- **HUD statusline** - Real-time orchestration metrics in your status bar
  - If you launch Claude Code directly with `claude --plugin-dir <path>` (bypassing the `omc` shim), export `OMC_PLUGIN_ROOT=<path>` in your shell so the HUD bundle resolves to the same checkout as the plugin loader. See the [Plugin directory flags section in REFERENCE.md](./docs/REFERENCE.md#plugin-directory-flags) for details.
- **Skill learning** - Extract reusable patterns from your sessions
- **Analytics & cost tracking** - Understand token usage across all sessions

### Contributing

Want to contribute to OMC? See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full developer guide, including how to fork, set up a local checkout, link it as your active plugin, run tests, and submit PRs.

### Custom Skills

Learn once, reuse forever. OMC extracts hard-won debugging knowledge into portable skill files that auto-inject when relevant.

|                 | Project Scope                                            | User Scope        |
| --------------- | -------------------------------------------------------- | ----------------- |
| **Path**        | `.omc/skills/`                                           | `~/.omc/skills/`  |
| **Shared with** | Team (commit the skill file to keep it across worktrees) | All your projects |
| **Priority**    | Higher (overrides user)                                  | Lower (fallback)  |

```yaml
# .omc/skills/fix-proxy-crash.md
---
name: Fix Proxy Crash
description: aiohttp proxy crashes on ClientDisconnectedError
triggers: ["proxy", "aiohttp", "disconnected"]
source: extracted
---
Wrap handler at server.py:42 in try/except ClientDisconnectedError...
```

**Manage skills:** `/skill list | add | remove | edit | search`
**Skillify:** `/skillify` extracts reusable patterns with strict quality gates
**Auto-inject:** Matching skills load into context automatically — no manual recall needed

Project-scoped OMC-authored skills are stored in `.omc/skills/` and are intended to be committed when you want them shared. During slash/skill execution OMC also reads Claude Code workspace skills from `.claude/skills/` and compatibility skills from `.agents/skills/`, so existing workspace-local `SKILL.md` packages remain callable without copying them into user-global skills. If you create project-local skills inside a linked git worktree and do not commit them, they disappear when that worktree is removed.

### `.omc/` state and git

OMC writes runtime state, session data, plans, logs, handoffs, research notes, and local artifacts under `.omc/` by default. The repository `.gitignore` keeps that runtime data local with one intentional exception: `.omc/skills/**` remains committable for project-scoped skills you want to share with the team. Treat everything else under `.omc/` as local operational state that may contain prompts, transcripts, or machine-specific paths.

For linked git worktrees, the default `.omc/` directory lives inside that worktree, so deleting the worktree deletes its local OMC state. Set `OMC_STATE_DIR` if you want state to survive worktree deletion, or add a `.omc-workspace` marker when several independent repos should share one parent-level state root. See [OMC state, gitignore, worktree, and workspace contract](docs/REFERENCE.md#omc-state-gitignore-worktree-and-workspace-contract).

Outside a git repository, OMC uses one canonical safe state root at `~/.omc/` (or `$OMC_STATE_DIR/non-git` when centralized state is configured); it does not create a new state root for every cwd or write state into sensitive directories such as `~/.ssh`, `~/Downloads`, or descendants of the system temp root. Legacy cwd-local state is untouched until explicitly migrated with `state_migrate_non_git`. State MCP tools honor an explicit `workingDirectory` while retaining repository-boundary checks for git-backed sessions.

[Full feature list →](docs/REFERENCE.md)

### Multi-repo workspaces

When several independent git repos share a parent directory, drop a `.omc-workspace` marker at the parent so all sub-repos share one `.omc/` state root:

```bash
cd /path/to/parent-dir-with-many-repos
echo '{"id":"my-workspace"}' > .omc-workspace
# Sessions inside any sub-repo now share /path/.omc/
# For parallel ultragoal runs:
cd repo-A && omc ultragoal create-goals --auto-plan-id --brief "..."
cd ../repo-B && omc ultragoal create-goals --auto-plan-id --brief "..."
```

See [Multi-repo workspaces in REFERENCE.md](docs/REFERENCE.md#multi-repo-workspaces-with-omc-workspace) for resolution order, `OMC_STATE_DIR`, and workspace identifier options.

---

## In-session shortcuts

These shortcuts run **inside a Claude Code / OMC session**, not as terminal CLI commands. For shell commands, use the `omc ...` forms shown above. Team mode is explicit: use `/team ...` in-session or `omc team ...` from your shell rather than expecting a bare `team` keyword trigger.

| In-session form            | Kind                   | Effect                                 | Example                                        |
| -------------------------- | ---------------------- | -------------------------------------- | ---------------------------------------------- |
| `/team`                    | Slash skill            | Canonical Team orchestration           | `/team 3:executor "fix all TypeScript errors"` |
| `/autopilot` / `autopilot` | Skill / prompt trigger | Full autonomous execution              | `/autopilot "build a todo app"`                |
| `/execute`                 | Slash skill            | Carry an approved task through to verified code | `/execute "refactor auth"`           |
| `/ralph` / `ralph`         | Skill / prompt trigger | Persistence mode                       | `/ralph "refactor auth"`                       |
| `/ralplan` / `ralplan`     | Skill / prompt trigger | Iterative planning consensus           | `/ralplan "plan this feature"`                 |
| `/deep-interview`          | Slash skill            | Socratic requirements clarification    | `/deep-interview "vague idea"`                 |
| `deepsearch`               | Prompt trigger         | Codebase-focused search routing        | `deepsearch for auth middleware`               |
| `ultrathink`               | Prompt trigger         | Deep reasoning mode                    | `ultrathink about this architecture`           |
| `cancelomc`, `stopomc`     | Prompt trigger         | Stop active OMC modes                  | `stopomc`                                      |

**Notes:**

- **Parallel work uses Team or executor delegation**: choose `/team` for coordinated lanes or delegate implementation tasks to executors; use Ralph when persistence until verified completion is the priority.
- `swarm` compatibility alias has been removed; migrate existing prompts to `/team` syntax.
- `plan this` / `plan the` keyword triggers were removed; use `ralplan` or explicit `/oh-my-claudecode:plan`.

## Utilities

### Provider Advisor (`omc ask` / `/ask`)

Run local provider CLIs and save a markdown artifact under `.omc/artifacts/ask/`.

```bash
# Terminal CLI
omc ask claude "review this migration plan"
omc ask codex --prompt "identify architecture risks"
omc ask gemini --prompt "propose UI polish ideas"
omc ask antigravity --prompt "propose UI polish ideas"
omc ask grok --prompt "cross-check this code review"
omc ask cursor --prompt "apply this implementation plan"
omc ask claude --agent-prompt executor --prompt "draft implementation steps"

# Inside a Claude Code / OMC session
/ask claude "review this migration plan"
/ask codex "identify architecture risks"
/ask antigravity "propose UI polish ideas"
/ask cursor "apply this implementation plan"
```

Canonical env vars:

- `OMC_ASK_ADVISOR_SCRIPT`
- `OMC_ASK_ORIGINAL_TASK`

Phase-1 aliases `OMX_ASK_ADVISOR_SCRIPT` and `OMX_ASK_ORIGINAL_TASK` are accepted with deprecation warnings.

### Autoresearch (stateful skill)

`omc autoresearch` is now a **hard-deprecated shim**. The authoritative workflow is:

```bash
/deep-interview --autoresearch improve startup performance
/oh-my-claudecode:autoresearch
```

- `deep-interview --autoresearch` generates/sets up the mission and evaluator
- `autoresearch` runs the bounded, single-mission stateful loop
- each iteration records evaluation JSON plus markdown decision logs
- non-passing iterations continue
- strict stopping is controlled by an explicit max-runtime ceiling

### Rate Limit Wait

Auto-resume Claude Code sessions when rate limits reset.

```bash
omc wait          # Check status, get guidance
omc wait --start  # Enable auto-resume daemon
omc wait --stop   # Disable daemon
```

**Requires:** tmux (for session detection)

### Monitoring & Observability

Use the HUD for live observability and the current session/replay artifacts for post-session inspection:

- HUD preset: `/oh-my-claudecode:hud setup` then use a supported preset such as `"omcHud": { "preset": "focused" }`
- Session summaries: `.omc/sessions/*.json`
- Replay logs: `.omc/state/agent-replay-*.jsonl`
- Live HUD rendering: `omc hud`
- Local friction reports: `omc session friction report --since 24h` summarizes context-bloat and operator-friction signals from local session artifacts without printing raw prompts or tool output; add `--json` for automation.

### Notification Tags (Telegram/Discord/Slack)

You can configure who gets tagged when stop callbacks send session summaries.

```bash
# Set/replace tag list
omc config-stop-callback telegram --enable --token <bot_token> --chat <chat_id> --tag-list "@alice,bob"
omc config-stop-callback discord --enable --webhook <url> --tag-list "@here,123456789012345678,role:987654321098765432"
omc config-stop-callback slack --enable --webhook <url> --tag-list "<!here>,<@U1234567890>"

# Incremental updates
omc config-stop-callback telegram --add-tag charlie
omc config-stop-callback discord --remove-tag @here
omc config-stop-callback discord --clear-tags
```

Tag behavior:

- Telegram: `alice` becomes `@alice`
- Discord: supports `@here`, `@everyone`, numeric user IDs, and `role:<id>`
- Slack: supports `<@MEMBER_ID>`, `<!channel>`, `<!here>`, `<!everyone>`, `<!subteam^GROUP_ID>`
- `file` callbacks ignore tag options

### OpenClaw Integration

Forward Claude Code session events to an [OpenClaw](https://openclaw.ai/) gateway to enable automated responses and workflows via your OpenClaw agent.

**Quick setup (recommended):**

```bash
/oh-my-claudecode:configure-notifications
# → When prompted, type "openclaw" → choose "OpenClaw Gateway"
```

**Manual setup:** create `~/.claude/omc_config.openclaw.json`:

```json
{
  "enabled": true,
  "gateways": {
    "my-gateway": {
      "url": "https://your-gateway.example.com/wake",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" },
      "method": "POST",
      "timeout": 10000
    }
  },
  "hooks": {
    "session-start": {
      "gateway": "my-gateway",
      "instruction": "Session started for {{projectName}}",
      "enabled": true
    },
    "stop": {
      "gateway": "my-gateway",
      "instruction": "Session stopping for {{projectName}}",
      "enabled": true
    }
  }
}
```

**Environment variables:**

| Variable                                   | Description               |
| ------------------------------------------ | ------------------------- |
| `OMC_OPENCLAW=1`                           | Enable OpenClaw           |
| `OMC_OPENCLAW_DEBUG=1`                     | Enable debug logging      |
| `OMC_OPENCLAW_CONFIG=/path/to/config.json` | Override config file path |

**Supported hook events (6 active in bridge.ts):**

| Event               | Trigger                                 | Key template variables                                |
| ------------------- | --------------------------------------- | ----------------------------------------------------- |
| `session-start`     | Session begins                          | `{{sessionId}}`, `{{projectName}}`, `{{projectPath}}` |
| `stop`              | Claude response completes               | `{{sessionId}}`, `{{projectName}}`                    |
| `keyword-detector`  | Every prompt submission                 | `{{prompt}}`, `{{sessionId}}`                         |
| `ask-user-question` | Claude requests user input              | `{{question}}`, `{{sessionId}}`                       |
| `pre-tool-use`      | Before tool invocation (high frequency) | `{{toolName}}`, `{{sessionId}}`                       |
| `post-tool-use`     | After tool invocation (high frequency)  | `{{toolName}}`, `{{sessionId}}`                       |

**Reply channel environment variables:**

| Variable                 | Description                    |
| ------------------------ | ------------------------------ |
| `OPENCLAW_REPLY_CHANNEL` | Reply channel (e.g. `discord`) |
| `OPENCLAW_REPLY_TARGET`  | Channel ID                     |
| `OPENCLAW_REPLY_THREAD`  | Thread ID                      |

See `scripts/openclaw-gateway-demo.mjs` for a reference gateway that relays OpenClaw payloads to a custom HTTPS automation endpoint.

---

## Documentation

- **[Full Reference](docs/REFERENCE.md)** - Complete feature documentation
- **[CLI Reference](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#cli-reference)** - All `omc` commands, flags, and tools
- **[Notifications Guide](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#notifications)** - Discord, Telegram, Slack, and webhook setup
- **[Recommended Workflows](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#workflows)** - Battle-tested skill chains for common tasks
- **[Release Notes](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#release-notes)** - What's new in each version
- **[Website](https://yeachan-heo.github.io/oh-my-claudecode-website)** - Interactive guides and examples
- **[Migration Guide](docs/MIGRATION.md)** - Upgrade from v2.x
- **[Architecture](docs/ARCHITECTURE.md)** - How it works under the hood
- **[Performance Monitoring](docs/PERFORMANCE-MONITORING.md)** - Agent tracking, debugging, and optimization
- **[Model × Agent Compatibility Matrix](docs/agents/model-compatibility.md)** - Which model to pair with each agent (premium / balanced / budget presets)
- **[Security Guide](SECURITY.md)** - Enterprise deployment and hardening

---

## Requirements

- [Claude Code](https://docs.anthropic.com/claude-code) CLI
- Claude Max/Pro subscription OR Anthropic API key

### Platform & tmux

OMC features like `omc team` and rate-limit detection require **tmux**:

| Platform       | tmux provider                                         | Install                 |
| -------------- | ----------------------------------------------------- | ----------------------- |
| macOS          | [tmux](https://github.com/tmux/tmux)                  | `brew install tmux`     |
| Ubuntu/Debian  | tmux                                                  | `sudo apt install tmux` |
| Fedora         | tmux                                                  | `sudo dnf install tmux` |
| Arch           | tmux                                                  | `sudo pacman -S tmux`   |
| Windows        | [psmux](https://github.com/marlocarlo/psmux) (native) | `winget install psmux`  |
| Windows (WSL2) | tmux (inside WSL)                                     | `sudo apt install tmux` |

> **Windows users:** [psmux](https://github.com/marlocarlo/psmux) provides a native `tmux` binary for Windows with 76 tmux-compatible commands. No WSL required.

### Optional: Multi-AI Orchestration

OMC can optionally orchestrate external AI providers for cross-validation and design consistency. These are **not required** — OMC works fully without them.

| Provider                                                                | Install                                                      | What it enables                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| [Antigravity CLI](https://antigravity.google) (`agy`)                   | Install per the [official instructions](https://antigravity.google) (provides the `agy` binary) | Design review, UI consistency — Google's successor to the Gemini CLI |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli)               | `npm install -g @google/gemini-cli`                          | Design review, UI consistency (1M token context) — enterprise/API-key access unaffected |
| [Codex CLI](https://github.com/openai/codex)                            | `npm install -g @openai/codex`                               | Architecture validation, code review cross-check                          |
| [Grok Build](https://build.grok.com)                                    | Download from build.grok.com (`grok` at `~/.grok/bin/grok`) | Code review, analysis cross-check                                         |

> **Migrating from Gemini CLI:** Per Google's announcement, the Gemini CLI is being superseded by the Antigravity CLI (`agy`); see the [official Antigravity docs](https://antigravity.google). Use `omc team N:antigravity` and `omc ask antigravity` wherever you previously used `gemini`. Windows headless support for `agy` is unknown/untested — report issues upstream.

**Cost:** 3 Pro plans (Claude + Antigravity/Gemini + ChatGPT) cover everything for ~$60/month.

---

## License

MIT

---

<div align="center">

**Inspired by:** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [claude-hud](https://github.com/ryanjoachim/claude-hud) • [Superpowers](https://github.com/obra/superpowers) • [everything-claude-code](https://github.com/affaan-m/everything-claude-code) • [Ouroboros](https://github.com/Q00/ouroboros)

**Zero learning curve. Maximum power.**

</div>

<!-- OMC:FEATURED-CONTRIBUTORS:START -->
## Featured by OmC Contributors

Top personal non-fork, non-archived repos from all-time OMC contributors (100+ GitHub stars).

- [@Yeachan-Heo](https://github.com/Yeachan-Heo) — [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) (⭐ 39k)
- [@junhoyeo](https://github.com/junhoyeo) — [tokscale](https://github.com/junhoyeo/tokscale) (⭐ 5.4k)
- [@psmux](https://github.com/psmux) — [psmux](https://github.com/psmux/psmux) (⭐ 3.5k)
- [@MeroZemory](https://github.com/MeroZemory) — [ida-multi-mcp](https://github.com/MeroZemory/ida-multi-mcp) (⭐ 414)
- [@devswha](https://github.com/devswha) — [patina](https://github.com/devswha/patina) (⭐ 354)
- [@GeiserX](https://github.com/GeiserX) — [awesome-spain](https://github.com/GeiserX/awesome-spain) (⭐ 337)
- [@BowTiedSwan](https://github.com/BowTiedSwan) — [buildflow](https://github.com/BowTiedSwan/buildflow) (⭐ 297)
- [@J-Pster](https://github.com/J-Pster) — [Psters_AI_Workflow](https://github.com/J-Pster/Psters_AI_Workflow) (⭐ 289)
- [@alohays](https://github.com/alohays) — [awesome-visual-representation-learning-with-transformers](https://github.com/alohays/awesome-visual-representation-learning-with-transformers) (⭐ 271)
- [@jcwleo](https://github.com/jcwleo) — [random-network-distillation-pytorch](https://github.com/jcwleo/random-network-distillation-pytorch) (⭐ 264)
- [@HaD0Yun](https://github.com/HaD0Yun) — [Doyunha-Gopeak](https://github.com/HaD0Yun/Doyunha-Gopeak) (⭐ 250)
- [@shaun0927](https://github.com/shaun0927) — [openchrome](https://github.com/shaun0927/openchrome) (⭐ 236)
- [@changeroa](https://github.com/changeroa) — [StyleGallery](https://github.com/changeroa/StyleGallery) (⭐ 223)
- [@emgeee](https://github.com/emgeee) — [mean-tutorial](https://github.com/emgeee/mean-tutorial) (⭐ 199)
- [@anduinnn](https://github.com/anduinnn) — [HiFiNi-Auto-CheckIn](https://github.com/anduinnn/HiFiNi-Auto-CheckIn) (⭐ 172)
- [@Znuff](https://github.com/Znuff) — [consolas-powerline](https://github.com/Znuff/consolas-powerline) (⭐ 145)

<!-- OMC:FEATURED-CONTRIBUTORS:END -->

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-claudecode&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-claudecode&type=date&legend=top-left)

## 💖 Support This Project

If Oh-My-ClaudeCode helps your workflow, consider sponsoring:

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-❤️-red?style=for-the-badge&logo=github)](https://github.com/sponsors/Yeachan-Heo)

### Why sponsor?

- Keep development active
- Priority support for sponsors
- Influence roadmap & features
- Help maintain free & open source

### Other ways to help

- ⭐ Star the repo
- 🐛 Report bugs
- 💡 Suggest features
- 📝 Contribute code

## GEO visibility benchmark

OmC includes a [`geobench`](https://github.com/NomaDamas/geobench) product spec for measuring LLM hit rate, MRR, share of voice, and citations.

- Spec: [`geobench/oh-my-claudecode.yaml`](geobench/oh-my-claudecode.yaml)
- Runbook: [`docs/geobench.md`](docs/geobench.md)
