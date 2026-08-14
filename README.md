# dsh-plugin-confirm-check

Confirm Mode for the DeepSeek Harness (dsh): task-level permission instead of
per-file gating.

Before starting work that can **permanently change something** (code edits,
config writes, git commits, installs, deletions, ...), the agent files **one
complete permission application** - a short description of what it is about to
do, which code paths it touches, and which mutating capabilities it needs.
After the user approves, everything inside that direction runs uninterrupted.
A background observer only compares later actions with the grant and reports
**drift** through the system prompt. Nothing is ever blocked: Confirm Mode
trusts the model and controls the overall direction, it does not gate
individual operations.

## What needs an application

| Action | Needs application |
| --- | --- |
| Read files, glob/grep, web search | No |
| Write plans/notes/documents (.md/.txt/.log/.plan/.notes/.adoc/.rst/.org) | No |
| Edit code/config files (write/edit of anything else) | Yes |
| Mutating commands (git commit/push, npm install, deletions, ...) | Yes |
| Read-only commands (git status/log/diff, ls, Get-*, ...) | No |

Drift = a mutating action outside the declared direction (a write outside the
declared paths, or a mutating command category that was not declared). At 5
drift events the system prompt asks the agent to check the direction and file
a fresh application instead of silently widening scope.

## Repository layout

```
package.json      plugin manifest (dsh.client declaration, exports["./client"])
lib/index.js      host half: tools, observers, /confirm-mode command, prompt section
lib/client.js     client half: the "Confirm Mode: on/off" composer toggle
```

## Installation

Prerequisites: a working dsh install (the `dsh` CLI on PATH, with a web
profile). The plugin loads as a real package from the profile module fallback
directory, plus one preset row.

### 1. Install the package

Copy this repository into the profile module directory (create it if needed):

```powershell
New-Item -ItemType Directory -Force "$HOME\.dsh\profiles\node_modules"
Copy-Item -Recurse . "$HOME\.dsh\profiles\node_modules\dsh-confirm-mode"
```

The bare specifier `dsh-confirm-mode` then resolves from every profile.

### 2. Add the preset row

Either edit an existing user preset under `$HOME\.dsh\.agent-presets\<id>\agent.cordis.yml`,
or copy the shipped `cordis` preset and edit the copy:

```yaml
- id: confirm-mode
  name: dsh-confirm-mode
```

The row publishes no service (it only consumes the host registries
`tools`, `systemPrompt`, `commands`, `userQuestions`, `agents`), so it needs
no `isolate` realm. Validate the composition with the harness preset tools
(`standingKeyFor`) before relying on it.

### 3. Start a session on that preset

Create a new session and select the preset you edited. The host half loads
with the session; the client half is discovered from the package.json
`dsh.client` declaration and the composer toggle appears next to the access
mode control (Full access / Read Only). Refresh the page once if the toggle
does not show up.

## Usage

### For the agent (model tools)

- `mission_permission` - file the one complete permission application before
  permanent changes: `summary` (the paragraph the user approves), optional
  `paths` (code/config prefixes), `capabilities` (files-write, commands),
  `duration`. The user approves or rejects once.
- `permission_status` - read-only view of the current grant and the drift log.

### For the user

- Composer toggle `Confirm Mode: on/off` (next to Full access / Read Only).
  Off = direction monitoring and prompt injection stop (the two model tools
  remain callable manually).
- `/confirm-mode on|off|toggle|status` - the same switch as a command.

## Configuration

Constants at the top of `lib/index.js`:

- `DRIFT_WARN` (5) - drift events before the prompt asks for a new application.
- `DOC_EXTS` - extensions treated as plan/note writes (never monitored).
- `READ_ONLY_PREFIXES` - command prefixes treated as read-only.

State is per-session and in memory: grants do not survive a process restart.

## License

MIT
