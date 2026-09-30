# dsh-plugin-confirm-check

Confirm Mode for the DeepSeek Harness (dsh): task-level permission instead of
per-file gating.

Before starting work that can **permanently change something** (code edits,
config writes, git commits, installs, deletions, ...), the agent files **one
complete permission application** - a short description of what it is about to
do, which code paths it touches, and which mutating capabilities it needs.
After the user approves, everything inside that direction runs uninterrupted.
A background observer only compares later actions with the grant and reports
**drift** in the periodic summary reminder. Nothing is ever blocked: Confirm
Mode trusts the model and controls the overall direction, it does not gate
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
drift events the next summary reminder asks the agent to check the direction
and file a fresh application instead of silently widening scope.

## Model-facing reminders

There is no permanent prompt section. The mode reaches the model as one-off
user-role reminders injected at accepted steps (`agent/pre-step`), so each
reminder is also a durable session event:

| Moment | Injection |
| --- | --- |
| Toggle flips off → on | One full briefing (rules + current grant state) |
| Session starts with the mode on | One full briefing at the first step |
| Every 5 turns while on | One short summary (grant/drift state, or "nothing filed yet") |
| Toggle flips on → off | One off-emphasis: do not file applications, proceed normally |
| Session starts with the mode off | Nothing — exactly like a session without the plugin |

While the mode is off, `mission_permission` short-circuits without asking the
user (outcome `off`), so a stray call never pops an approval request.

## Repository layout

```
package.json      plugin manifest (dsh.bundle.patch, dsh.client, exports["./client"])
cordis.patch.yml  bundle patch: inserts the host row
lib/index.js      host half: tools, observers, /confirm-mode command, step reminders
lib/client.js     client half: the "Confirm Mode: on/off" composer toggle
```

## Installation

This package is a **profile bundle**: `package.json` declares
`dsh.bundle.patch`, and `cordis.patch.yml` inserts the host row. One command
installs it into a profile — it links the package, registers the bundle and
enables the row — and the change applies immediately through HMR:

```
plugin_manager action=install_bundle target=E:\dsh\dsh-plugin-confirm-check
```

Do not write the profile's `package.json` or `cordis.patch.yml` by hand, and do
not copy or Junction the package into `$DSH_HOME\profiles\node_modules`.

> **Why the old copy/Junction method broke on Desktop 0.2.0:** a package placed
> or linked in `$DSH_HOME\profiles\node_modules` resolves its `@deepseek-ai/*`
> peers against that same shared directory, which the Desktop module resolver
> treats as an **obsolete fallback** and rejects. `install_bundle` links the
> package under the profile instead, so peers resolve from the app's own
> install.

### Alternative: an agent preset (per session)

To give Confirm Mode to one preset instead of the whole profile, add the same
row to an existing user preset at
`$HOME\.dsh\.agent-presets\<id>\agent.cordis.yml`, or copy the shipped `cordis`
preset and edit the copy. Watch out for the picker: the session-mode picker is
the preset ROSTER — every preset directory appears there as a session mode
labeled by its `preset.yml` `name`. Create a standalone preset (with its own
`preset.yml`) only if you want that extra picker entry on purpose.

Validate the composition with the harness preset tools (`standingKeyFor`)
before relying on it.

### Verify

- the row `include:confirm-mode` reports `enabled: true, fiberPhase: "active"`
  (`plugin_manager action=list_plugins`), then
- refresh the browser once: the `Confirm Mode: on/off` toggle appears next to
  the access control (Full access / Read Only).

The toggle and the grant state are process-wide: switching the mode off in one
session switches it off for every session.
session-mode picker is the preset ROSTER — every preset directory appears
there as a session mode labeled by its `preset.yml` `name`. Installing this
package never adds a mode by itself; only a preset directory does.

Validate the composition with the harness preset tools (`standingKeyFor`)
before relying on it. For a preset mount, start a session on that preset and
refresh once if the toggle does not show up.

## Usage

### For the agent (model tools)

- `mission_permission` - file the one complete permission application before
  permanent changes: `summary` (the paragraph the user approves), optional
  `paths` (code/config prefixes), `capabilities` (files-write, commands),
  `duration`. The user decides once; the tool reports which answer it got:
  `approved`, `rejected`, `custom` (the user typed an answer of their own),
  `unanswered` (skipped), `cancelled` (card closed), `delegated` (a subagent
  cannot ask), or `off`.
- `permission_status` - read-only view of the current grant and the drift log.

### For the user

- Composer toggle `Confirm Mode: on/off` (next to Full access / Read Only).
  Off = monitoring stops, reminders stop, and `mission_permission`
  short-circuits without asking (the two model tools remain registered).
- `/confirm-mode on|off|toggle|status` - the same switch as a command.
- The application itself is an ordinary question card: pick `Approve` or
  `Reject`, or type your own answer in the free-text field to answer with
  conditions, a narrower scope, or a correction. A typed answer replaces the
  options (the harness's single-select answer rule: free text overrides the
  selection), and the model receives it verbatim.

### Card presentation

The application renders through the harness's generic question card - the only
card that offers a free-text answer. That card styles its markdown `detail`
block for a short note (no heading scale, `margin: 0 2px` inside an unpadded
body), unlike the plan-review card it replaced (`padding: 12px 16px`, 14px
type). Two consequences are handled here:

- `buildPlanText` emits no markdown headings: `##`/`###` arrive as full-size
  headings with 32px outer margins, which dwarf the card's own title and push
  the options and the free-text field below the fold. The plan is a compact
  `**Goal** / **Paths** / **Capabilities** / **Scale**` block plus one
  blockquote line of approval semantics.
- The client half insets that block to 16px
  (`[data-question-scroll]>div:first-child:not([role])`), because the harness
  ships it at 2px while the card's header sits at 24px and its option list at
  12px. Delete the rule once the harness pads the block itself; the selector is
  structural, so a harness class-name change only makes it stop matching. The
  rule rides the same style tag as the toggle, rewritten on every client load,
  so a hot-reloaded half never renders with a stale stylesheet.

## Configuration

Constants at the top of `lib/index.js`:

- `DRIFT_WARN` (5) - drift events before the summary reminder asks for a new application.
- `SUMMARY_EVERY` (5) - turns between summary reminders while the mode is on.
- `DOC_EXTS` - extensions treated as plan/note writes (never monitored).
- `READ_ONLY_PREFIXES` - command prefixes treated as read-only.

Grants are keyed by session and live in memory: they do not survive a process
restart. The on/off toggle is process-wide under a host-plane mount, and
per-session under a preset mount (each session mounts its own row instance).

## License

MIT
