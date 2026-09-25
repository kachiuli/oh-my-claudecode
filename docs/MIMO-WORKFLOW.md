# MiMo v2.6 in OMC and Claude Code

Workflow v1.5.6 adds an opt-in `mimo` worker route through the existing Claude Code worker transport. Xiaomi's model IDs are `mimo-v2.6-pro` (the standard v2.6 model) and `mimo-v2.6-flash`. It does not require a MiMo SDK. Keep your normal `claude` and `claude-glm` profiles; the new `claude-mimo` launcher selects a third, isolated profile.

## Create the MiMo profile

Get a MiMo API key from the [MiMo console](https://platform.xiaomimimo.com/). Pay-as-you-go uses `https://api.xiaomimimo.com/anthropic`. If you use a Token Plan, use the **Anthropic-compatible Base URL and Token Plan key shown on your plan page**; plan keys are separate from pay-as-you-go keys. Xiaomi's [Claude Code setup guide](https://mimo.mi.com/docs/en-US/tokenplan/integration/claudecode) documents both.

Create `~/.claude-mimo/settings.json` (on Windows, `%USERPROFILE%\.claude-mimo\settings.json`) with your key and selected URL:

```json
{
  "model": "mimo-v2.6-pro",
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "YOUR_MIMO_KEY",
    "ANTHROPIC_BASE_URL": "https://api.xiaomimimo.com/anthropic",
    "ANTHROPIC_MODEL": "mimo-v2.6-pro",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "mimo-v2.6-pro",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "mimo-v2.6-pro",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "mimo-v2.6-flash"
  }
}
```

Edit the file locally and keep the key out of OMC config, project settings, prompts, and commits. Project or managed Claude Code settings can override user settings; remove conflicting provider overrides there if the MiMo profile does not select MiMo. The MiMo and GLM profiles have separate settings and do not change your default Claude sign-in.

## Add a `claude-mimo` command

On **native Windows**, OMC requires a directly executable worker command. From this repository checkout, run in PowerShell:

```powershell
$claudeExe = (Get-Command claude.exe -ErrorAction Stop).Source
$bin = Split-Path -Parent $claudeExe
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo /target:exe "/out:$(Join-Path $bin 'claude-mimo.exe')" .\scripts\windows\claude-mimo.cs
if ($LASTEXITCODE -ne 0) { throw 'MiMo launcher build failed' }
claude-mimo --version
```

The supplied launcher must sit beside the native `claude.exe`. It forwards arguments and exit status, clears inherited Anthropic auth overrides, and selects `%USERPROFILE%\.claude-mimo`. It fails if the profile file is absent. It contains no key. The example uses Windows' .NET Framework compiler; if it is unavailable, build the included C# source with another trusted C# compiler. `.cmd`, `.bat`, and `.ps1` launchers cannot be used for this isolated OMC route.

On **Linux, macOS, or WSL**, create `~/.local/bin/claude-mimo`:

```bash
#!/usr/bin/env bash
set -euo pipefail
for name in "${!ANTHROPIC_@}"; do unset "$name"; done
unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY
export CLAUDE_CONFIG_DIR="$HOME/.claude-mimo"
exec claude "$@"
```

Make it executable (`chmod +x ~/.local/bin/claude-mimo`) and put `~/.local/bin` on PATH. Configure a separate MiMo profile inside WSL if you run OMC there; native Windows and WSL home directories differ.

Run `claude-mimo` once interactively, complete first-run prompts, and check `/status`. You can select Flash for an interactive session with `claude-mimo --model mimo-v2.6-flash`. Verify ordinary `claude` and `claude-glm` still use their original accounts. Both MiMo IDs and the Anthropic-compatible endpoint are listed in Xiaomi's [API reference](https://mimo.mi.com/docs/en-US/api/chat/anthropic-api).

## Route OMC workers

Add this to your OMC user `config.jsonc` (on native Windows, `%APPDATA%\claude-omc\config.jsonc`) or a project `.claude/omc.jsonc`:

```json
{
  "team": {
    "mimo": { "command": "claude-mimo", "fallback": false }
  },
  "externalModels": {
    "defaults": { "mimoModel": "mimo-v2.6-pro" }
  }
}
```

Use `mimo-v2.6-flash` in `mimoModel` to make Flash the default. `OMC_MIMO_DEFAULT_MODEL` temporarily overrides that setting. To route ordinary team implementation roles through MiMo, also set `"team": { "profile": "claude-mimo-codex", ... }`; that preset keeps Claude for planning and Codex for review. To keep your existing GLM team preset, omit the MiMo profile and select MiMo only for the commands that need it:

```text
omc doctor --team-routing
omc ask mimo "Reply briefly without changing files."
omc team 2:mimo "Implement the scoped tasks"
omc team workflow init --file .omc/plans/feature.json --profile claude-mimo-codex
```

The last command selects a Claude lead, MiMo implementers, and a Codex reviewer for that workflow. Your existing GLM route remains available as `omc ask glm` or `omc team N:glm`. A missing MiMo launcher fails closed; OMC does not silently spend Claude or GLM quota. `doctor` checks routing and executable availability, while `omc ask mimo` makes a live call and uses MiMo quota. This release's automated checks do not use a MiMo account.
