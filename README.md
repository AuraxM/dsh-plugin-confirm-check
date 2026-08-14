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
directory, plus one row in a composition (host profile patch or agent
preset). Installing the package alone changes nothing — the row placement in
step 2 decides who gets Confirm Mode. This repository ships no install
scripts and never writes outside its own files: every mount is a manual row.

### 1. Install the package

Copy this repository into the profile module directory (create it if needed):

```powershell
New-Item -ItemType Directory -Force "$HOME\.dsh\profiles\node_modules"
Copy-Item -Recurse . "$HOME\.dsh\profiles\node_modules\dsh-confirm-mode"
```

The bare specifier `dsh-confirm-mode` then resolves from every profile.

### 2. Mount the row

The row publishes no service (it only consumes the host registries
`tools`, `systemPrompt`, `commands`, `userQuestions`, `agents`), so it needs
no `isolate` realm. Two placements are supported:

**Host plane — all sessions** (global). Add an `insert` entry to the web
profile's patch layer `$HOME\.dsh\profiles\web\cordis.patch.yml`:

```yaml
- insert:
    - id: confirm-mode
      name: dsh-confirm-mode
```

Profile boot watches this file (`watchUserPatches`), so the edit hot-reloads
into the running server — no restart needed. Every session gains the tools,
the `/confirm-mode` command, the prompt section, and the composer toggle. The
toggle and the grant state are process-wide: switching the mode off in one
session switches it off for every session.

**Agent preset — per session.** Append the same row to an existing user
preset at `$HOME\.dsh\.agent-presets\<id>\agent.cordis.yml`, or copy the
shipped `cordis` preset and edit the copy. Watch out for the picker: the
session-mode picker is the preset ROSTER — every preset directory appears
there as a session mode labeled by its `preset.yml` `name`. Installing this
package never adds a mode by itself; only a preset directory does. Create a
standalone preset (with its own `preset.yml`) only if you want that extra
picker entry on purpose.

Validate the composition with the harness preset tools (`standingKeyFor`)
before relying on it.

### 3. Verify the mount, then start

Host-plane mount — verify against the live server before refreshing the page:

- the served web root embeds `window.__DSH_BOOT__`; its `entries` list must
  contain id `dsh-confirm-mode` (the entry id is the PACKAGE name, not the
  row id), and
- `GET /plugins/dsh-confirm-mode/client.js` must return 200.

Then refresh the browser once: the `Confirm Mode: on/off` toggle appears next
to the access control (Full access / Read Only), and Settings → Plugins lists
`dsh-confirm-mode` as active. For a preset mount, start a session on that
preset instead; same toggle location, refresh once if it does not show up.

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

Grants are keyed by session and live in memory: they do not survive a process
restart. The on/off toggle is process-wide under a host-plane mount, and
per-session under a preset mount (each session mounts its own row instance).

## License

MIT
