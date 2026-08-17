/**
 * Confirm Mode - Host half.
 *
 * Task-level permission, not per-file gating: before starting work that can
 * permanently change something (code edits, config writes, git commits,
 * installs, deletions, ...), the model files ONE complete permission
 * application through the `mission_permission` tool. After approval, actions
 * inside the declared direction run uninterrupted; a background observer only
 * compares them with the grant (drift = writes outside declared paths or
 * non-read-only commands) and reports drift in the periodic summary reminder.
 * Nothing
 * is ever blocked - this is direction control, not an access gate.
 *
 * Reads, document/note writes (.md/.txt/.log/.plan/.notes/...), and read-only
 * commands are exempt from application and monitoring.
 *
 * The `/confirm-mode` command is the client toggle's channel:
 *   /confirm-mode on|off|toggle|status
 *
 * Model-facing notice is REMINDER-based (agent/pre-step UserMessages), not a
 * permanent prompt section: a full briefing once when the mode turns on (or at
 * the first step of a session that starts on), a short summary every
 * SUMMARY_EVERY turns while on, one off-emphasis when the mode turns off, and
 * nothing for a session that starts off. While off, mission_permission
 * short-circuits without asking the user.
 *
 * Publishes no service - consumes host registries (tools, commands,
 * userQuestions, agents) - so it needs no isolate realm.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

const name = "confirm-mode";
const inject = ["tools", "commands", "userQuestions", "agents"];

const DRIFT_WARN = 5;
const SUMMARY_EVERY = 5;
const MAX_RECENT = 20;
const PLUGIN_SOURCE = "dsh-confirm-mode";
const BS = String.fromCharCode(92); // backslash, avoiding escape pitfalls

const CATEGORY = {
  read: "files-read", read_image: "files-read", glob: "files-read", grep: "files-read",
  write: "files-write", edit: "files-write",
  pwsh: "commands",
  job_output: "jobs", job_list: "jobs", job_kill: "jobs",
  web_search: "network",
  subagent: "subagents", subagent_fork: "subagents", workflow: "subagents",
  send_message: "subagents", interrupt_agent: "subagents", list_agents: "subagents",
  create_goal: "goals", update_goal: "goals", get_goal: "goals",
  ralph: "iteration",
  mission_permission: "permission", permission_status: "permission"
};

// Non-permanent categories: exempt from application and monitoring.
const NON_MUTATING = { "files-read": true, network: true, subagents: true, jobs: true, goals: true, iteration: true, skills: true, planning: true, harness: true, "user-questions": true, permission: true, other: true };

// Plan/note file writes do not change the product's final form.
const DOC_EXTS = ["md", "txt", "log", "plan", "notes", "adoc", "rst", "org"];

// Clearly read-only command prefixes; everything else counts as possibly permanent.
const READ_ONLY_PREFIXES = [
  "git status", "git log", "git diff", "git show", "git rev-parse", "git remote", "git branch", "git fetch", "git ls-files",
  "git config --list", "git config --get", "git version", "git --version",
  "get-", "ls ", "dir ", "cat ", "type ", "where ", "select-string", "test-path", "get-content", "get-item", "get-location", "resolve-path",
  "node -v", "npm -v", "npm list", "npm ls", "pnpm -v", "pnpm list", "python --version", "pwsh -version", "java -version"
];

function categoryOf(toolName) {
  if (typeof toolName !== "string") return "other";
  if (Object.prototype.hasOwnProperty.call(CATEGORY, toolName)) return CATEGORY[toolName];
  if (toolName.indexOf("cordis_") === 0) return "harness";
  return "other";
}

function normPath(p) {
  if (typeof p !== "string") return "";
  let s = p.split(BS).join("/").toLowerCase();
  while (s.length > 1 && s.charAt(s.length - 1) === "/") s = s.slice(0, -1);
  return s;
}

function isDocFile(p) {
  const n = normPath(p);
  if (!n) return false;
  const i = n.lastIndexOf(".");
  if (i < 0) return false;
  return DOC_EXTS.indexOf(n.slice(i + 1)) >= 0;
}

function commandIsReadOnly(cmd) {
  if (typeof cmd !== "string" || cmd.length === 0) return false;
  const c = cmd.toLowerCase().replace(/\s+/g, " ");
  const hit = READ_ONLY_PREFIXES.some((p) => c.indexOf(p) === 0);
  if (!hit) return false;
  // Some prefixes can carry mutating flags: git branch -d/-m/-c, git remote add/remove/set-url
  if (c.indexOf("git branch") === 0 && (c.indexOf("-d") >= 0 || c.indexOf("-m") >= 0 || c.indexOf("-c") >= 0)) return false;
  if (c.indexOf("git remote") === 0 && (c.indexOf(" add") >= 0 || c.indexOf(" remove") >= 0 || c.indexOf("set-url") >= 0)) return false;
  return true;
}

function agentId(a) {
  return a && typeof a === "object" && typeof a.id === "string" ? a.id : undefined;
}

function stamp() {
  try { return typeof Date === "function" ? new Date().toISOString() : ""; } catch { return ""; }
}

function apply(ctx) {
  // ---- per-session in-memory state ----
  const grants = new Map(); // sessionId -> grant
  let uiEnabled = true; // the composer toggle
  let toggleSeq = 0; // bumped on every actual on/off flip
  const reminderStates = new WeakMap(); // Agent -> { seenToggleSeq, onTurns }

  function setEnabled(next) {
    if (next === uiEnabled) return;
    uiEnabled = next;
    toggleSeq += 1;
  }

  function grantFor(sessionId) {
    return typeof sessionId === "string" ? grants.get(sessionId) : undefined;
  }

  // Does one tool dispatch cause a permanent change? undefined = exempt.
  function permanentTargetOf(toolName, args) {
    const category = categoryOf(toolName);
    if (category === "files-write") {
      const p = args && typeof args.file_path === "string" ? args.file_path : "";
      if (!p || isDocFile(p)) return undefined;
      return { category, paths: [p] };
    }
    if (category === "commands") {
      const cmd = args && typeof args.command === "string" ? args.command : "";
      if (!cmd || commandIsReadOnly(cmd)) return undefined;
      return { category, paths: [] };
    }
    return undefined;
  }

  function capsOk(grant, category) {
    if (!grant) return true;
    if (Object.prototype.hasOwnProperty.call(NON_MUTATING, category)) return true;
    const caps = grant.capabilities || [];
    if (caps.length === 0) return true;
    return caps.some((c) => {
      if (typeof c !== "string") return false;
      return category === c || category.indexOf(c) === 0 || c.indexOf(category) === 0;
    });
  }

  function pathsOk(grant, category, paths) {
    if (!grant || category !== "files-write") return true;
    const scoped = grant.paths || [];
    if (scoped.length === 0) return true;
    return paths.every((p) => {
      const n = normPath(p);
      if (!n) return true;
      return scoped.some((prefix) => {
        const g = normPath(prefix);
        if (!g) return true;
        if (g.indexOf("/") >= 0 || g.indexOf(":") >= 0) return n === g || n.indexOf(g + "/") === 0;
        return n === g || n.indexOf("/" + g) >= 0;
      });
    });
  }

  function inScope(grant, hit) {
    return capsOk(grant, hit.category) && pathsOk(grant, hit.category, hit.paths);
  }

  function recordDrift(sessionId, entry) {
    const grant = grantFor(sessionId);
    if (!grant) return;
    grant.driftCount += 1;
    grant.outOfScope.push(entry);
    if (grant.outOfScope.length > MAX_RECENT) grant.outOfScope.shift();
  }

  // ---- observers: record only, never veto; inert while the toggle is off ----
  function observeToolExec(exec) {
    if (!uiEnabled) return;
    if (!exec || typeof exec.name !== "string") return;
    const sessionId = agentId(exec.agent);
    if (!sessionId) return;
    const grant = grantFor(sessionId);
    if (!grant) return;
    const hit = permanentTargetOf(exec.name, exec.arguments);
    if (!hit) return;
    if (!inScope(grant, hit)) {
      recordDrift(sessionId, { tool: exec.name, category: hit.category, paths: hit.paths.slice(0, 3), at: stamp() });
    }
  }

  function observeFsIntent(target, kind) {
    if (!uiEnabled) return;
    const display = target && typeof target.displayPath === "string" ? target.displayPath : undefined;
    if (!display) return;
    if (isDocFile(display)) return;
    let sessionId;
    try { sessionId = agentId(ctx.agents.currentInitiator()); } catch { sessionId = undefined; }
    if (!sessionId) return;
    const grant = grantFor(sessionId);
    if (!grant) return;
    const hit = { category: "files-write", paths: [display] };
    if (!inScope(grant, hit)) {
      recordDrift(sessionId, { tool: kind, category: "files-write", paths: [display], at: stamp() });
    }
  }

  ctx.on("tools/pre-execute", (exec, next) => {
    try { observeToolExec(exec); } catch (error) { ctx.logger?.error?.("confirm-mode: observe tools failed", error); }
    return next();
  });

  ctx.on("fs/write-intent", (target, _actor, next) => {
    try { observeFsIntent(target, "fs.write"); } catch (error) { ctx.logger?.error?.("confirm-mode: observe fs.write failed", error); }
    return next();
  });

  ctx.on("fs/edit-intent", (target, _actor, next) => {
    try { observeFsIntent(target, "fs.edit"); } catch (error) { ctx.logger?.error?.("confirm-mode: observe fs.edit failed", error); }
    return next();
  });

  ctx.on("agent/disposed", (payload) => {
    const id = agentId(payload && payload.agent);
    if (id) grants.delete(id);
  });

  function buildPlanText(args) {
    const lines = ["## Mission direction", String(args && args.summary ? args.summary : "")];
    const paths = args && Array.isArray(args.paths) ? args.paths : [];
    if (paths.length > 0) lines.push("\n### Paths to modify\n- " + paths.join("\n- "));
    const caps = args && Array.isArray(args.capabilities) ? args.capabilities : [];
    if (caps.length > 0) lines.push("\n### Mutating capabilities\n- " + caps.join("\n- "));
    if (args && typeof args.duration === "string" && args.duration) lines.push("\n### Expected scale\n" + args.duration);
    lines.push("\n> After approval, operations inside this direction are not asked about again; reads and plan/note writes are not monitored.");
    return lines.join("\n");
  }

  function snapshotFor(sessionId) {
    const grant = grantFor(sessionId);
    if (!grant) return { declared: false, message: "This session has not filed a Confirm Mode application yet." };
    return {
      declared: true,
      summary: grant.summary,
      paths: grant.paths.slice(),
      capabilities: grant.capabilities.slice(),
      custom: grant.custom || "",
      at: grant.at || "",
      driftCount: grant.driftCount || 0,
      outOfScope: grant.outOfScope.slice(-10)
    };
  }

  // ---- model tool 1: the one complete permission application ----
  ctx.tools.register(defineTool({
    name: "mission_permission",
    description: "[Confirm Mode permission] Applies only while Confirm Mode is ON (announced by one-time [Confirm Mode] reminders); while it is off, do NOT file applications - no approval is required. Before starting work that can permanently change something (code edits, git commits, installing/removing dependencies, ...), describe what you will do in one paragraph and file ONE complete permission application (not per-file requests). Merely reading files, or writing plans/notes/documents that do not affect the final product, needs no application. After approval, operations inside the direction are not asked about again; the system only monitors direction and prompts you to renew the application when it drifts. Nothing is ever blocked.",
    parameters: {
      summary: { type: "string", required: true, description: "Briefly describe what you will do: the goal, rough steps, and impact. This is what the user sees and approves." },
      paths: { type: "array", description: "Code/config paths or directory prefixes you expect to modify permanently, e.g. E:/dsh or src/. Leave empty for unrestricted write paths.", items: { type: "string" } },
      capabilities: { type: "array", description: "Mutating capability categories you expect to use: files-write (edit code/config), commands (mutating commands such as git commit or installing dependencies). Leave empty to allow all.", items: { type: "string" } },
      duration: { type: "string", description: "Optional expected scale, e.g. 'about 5 minutes, 3 files'." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          outcome: { type: "string" },
          message: { type: "string" }
        }
      },
      render: (_args, value) => {
        const head = value && value.outcome === "approved" ? "Permission approved" : value && value.outcome === "rejected" ? "Permission rejected" : value && value.outcome === "off" ? "Confirm Mode off" : "Permission application";
        return [{ type: "text", text: head + "\n" + String(value && value.message ? value.message : "") }];
      }
    },
    async execute(args, exec) {
      if (!uiEnabled) {
        return { outcome: "off", message: "Confirm Mode is currently OFF: no permission application is required and none was requested. Proceed with the work directly, and do not call mission_permission again while the mode stays off." };
      }
      const sessionId = agentId(exec && exec.agent);
      try {
        const answer = await ctx.userQuestions.ask({
          questions: [{
            id: "grant",
            header: "Confirm Mode - Permission Application",
            question: "Approve this mission direction?",
            detail: buildPlanText(args),
            options: [
              { label: "Approve", description: "Proceed in this direction; operations inside it are not asked about again, the system only monitors direction" },
              { label: "Reject", description: "Wrong direction; adjust and apply again" }
            ],
            intent: { kind: "plan-review", approve: "Approve" }
          }],
          ...exec && exec.agent !== undefined ? { agent: exec.agent } : {},
          signal: exec.signal
        });
        const item = Array.isArray(answer.answers) ? answer.answers.find((a) => a.id === "grant") : undefined;
        const selected = item && Array.isArray(item.selected) ? item.selected : [];
        const custom = item && typeof item.custom === "string" ? item.custom.trim() : "";
        if (selected.indexOf("Approve") >= 0) {
          if (sessionId) {
            grants.set(sessionId, {
              summary: typeof args.summary === "string" ? args.summary : "",
              paths: Array.isArray(args.paths) ? args.paths.filter((p) => typeof p === "string") : [],
              capabilities: Array.isArray(args.capabilities) ? args.capabilities.filter((c) => typeof c === "string") : [],
              custom,
              at: stamp(),
              driftCount: 0,
              outOfScope: []
            });
          }
          return {
            outcome: "approved",
            message: "Permission approved. Proceed; operations inside this direction are not asked about again. If the direction changes materially later, call mission_permission again for a new application." + (custom ? "\nUser note: " + custom : "")
          };
        }
        return {
          outcome: "rejected",
          message: "The user did not approve this direction." + (custom ? " User note: " + custom : "") + " Adjust the plan and apply again, or clarify the request with a plain message first."
        };
      } catch (error) {
        const code = error && typeof error === "object" ? error.code : undefined;
        if (code === "CALLER_NOT_LIVE" || code === "DELEGATED_CALLER") {
          return { outcome: "delegated", message: "You are a subagent and cannot pop the permission question to the user directly. Put the plan into your report and let the root session call mission_permission." };
        }
        return { outcome: "error", message: "Permission application failed: " + String(error && error.message ? error.message : error) };
      }
    }
  }));

  // ---- model tool 2: read-only permission status ----
  ctx.tools.register(defineTool({
    name: "permission_status",
    description: "View this session's Confirm Mode permission state and drift log (read-only, changes nothing).",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          declared: { type: "boolean" },
          message: { type: "string" },
          summary: { type: "string" },
          paths: { type: "array", items: { type: "string" } },
          capabilities: { type: "array", items: { type: "string" } },
          custom: { type: "string" },
          at: { type: "string" },
          driftCount: { type: "number" },
          outOfScope: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                tool: { type: "string" },
                category: { type: "string" },
                paths: { type: "array", items: { type: "string" } },
                at: { type: "string" }
              }
            }
          }
        }
      },
      render: (_args, value) => {
        const text = value && value.declared
          ? "Confirm Mode: approved - drift " + (value.driftCount || 0) + " times\n" + String(value.summary || "")
          : "Confirm Mode: no application yet\n" + String(value.message || "");
        return [{ type: "text", text }];
      }
    },
    execute(_args, exec) {
      return snapshotFor(agentId(exec && exec.agent));
    }
  }));

  // ---- the composer toggle's command channel ----
  ctx.commands.register({
    name: "confirm-mode",
    description: "Toggle or view Confirm Mode (task-level permission for permanent changes)",
    input: { hint: "[on|off|toggle|status]" },
    handler: (invocation) => {
      const arg = String(invocation.rawInput || "").trim().toLowerCase();
      if (arg === "on" || arg === "") {
        setEnabled(true);
        return { kind: "success", text: "on Confirm Mode enabled" };
      }
      if (arg === "off") {
        setEnabled(false);
        return { kind: "success", text: "off Confirm Mode disabled" };
      }
      if (arg === "toggle") {
        setEnabled(!uiEnabled);
        return { kind: "success", text: (uiEnabled ? "on" : "off") + " Confirm Mode " + (uiEnabled ? "enabled" : "disabled") };
      }
      if (arg === "status") {
        let drift = 0;
        grants.forEach((g) => { drift += g.driftCount || 0; });
        return { kind: "success", text: (uiEnabled ? "on" : "off") + " Confirm Mode " + (uiEnabled ? "enabled" : "disabled") + (drift > 0 ? " - drift " + drift + " times" : "") };
      }
      return { kind: "error", text: "usage: /confirm-mode [on|off|toggle|status]" };
    }
  });

  // ---- reminder texts ----
  function fullReminderText(sessionId) {
    const grant = grantFor(sessionId);
    const lines = [
      "[Confirm Mode] Confirm Mode is ON for this session.",
      "Before operations that can permanently change something (code edits, git commits, installing/removing dependencies, ...), call mission_permission ONCE: describe what you will do and which code paths it touches. Merely reading files, writing plans/notes/documents, or searching needs no application and is not monitored.",
    ];
    if (grant) {
      lines.push("An approved grant is already active: \"" + String(grant.summary || "").slice(0, 160) + "\" (drift " + (grant.driftCount || 0) + " times). Keep working inside it; operations inside the approved direction are not asked about again.");
    } else {
      lines.push("No permission application has been filed yet.");
    }
    lines.push("After approval, a background observer only reports drift. If the direction changes materially (new goal, clearly beyond declared paths or capabilities), call mission_permission again for a new application instead of silently widening scope; if rejected, adjust the direction or clarify the request first. This is direction control, not an operation gate.");
    lines.push("This is the one-time full briefing. While the mode stays on, a short summary reminder follows every " + SUMMARY_EVERY + " turns.");
    return lines.join("\n");
  }

  function summaryReminderText(sessionId) {
    const grant = grantFor(sessionId);
    if (!grant) {
      return "[Confirm Mode] Still on; no permission application filed yet. File mission_permission once before permanent changes (code edits, git commits, installs); reads and plan/note writes need none.";
    }
    const warn = (grant.driftCount || 0) >= DRIFT_WARN
      ? " Drift has passed " + DRIFT_WARN + " times: check whether the direction has changed and, if so, file a new application now."
      : "";
    return "[Confirm Mode] Still on. Grant \"" + String(grant.summary || "").slice(0, 120) + "\" active, drift " + (grant.driftCount || 0) + " times. Stay inside the declared direction; file a new application if it changes materially." + warn;
  }

  function offReminderText() {
    return "[Confirm Mode] Confirm Mode is now OFF for this session. Do NOT call mission_permission and do not file permission applications: no approval is required and direction monitoring is disabled. Proceed exactly as in a session without Confirm Mode. If the mode is turned back on, you will receive a fresh full briefing at that point.";
  }

  function reminderMessage(text, summary) {
    return createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: "plugin", plugin: PLUGIN_SOURCE, form: "notice", summary }
    });
  }

  // The reminder (if any) an agent should see at its next accepted step.
  function pendingReminder(agent, step) {
    const sessionId = agentId(agent);
    let state = reminderStates.get(agent);
    if (!state) {
      // Session-initial: a full briefing only when the session starts on;
      // a session that starts off hears nothing, like a normal session.
      state = { seenToggleSeq: toggleSeq, onTurns: 0 };
      reminderStates.set(agent, state);
      return uiEnabled ? { text: fullReminderText(sessionId), summary: "Confirm Mode on" } : undefined;
    }
    if (state.seenToggleSeq !== toggleSeq) {
      // A flip happened since this agent's last step: brief it exactly once.
      state.seenToggleSeq = toggleSeq;
      state.onTurns = 0;
      return uiEnabled
        ? { text: fullReminderText(sessionId), summary: "Confirm Mode on" }
        : { text: offReminderText(), summary: "Confirm Mode off" };
    }
    if (!uiEnabled || step !== 1) return undefined;
    state.onTurns += 1;
    if (state.onTurns < SUMMARY_EVERY) return undefined;
    state.onTurns = 0;
    return { text: summaryReminderText(sessionId), summary: "Confirm Mode reminder" };
  }

  // ---- reminder injection: one UserMessage per accepted step, only when due ----
  // The loop commits decision messages as user/message session events, so
  // every reminder stays reconstructable from the session log.
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    try {
      if (!decision || decision.kind !== "enter") return decision;
      if (!payload || !payload.agent) return decision;
      if (payload.signal && payload.signal.aborted) return decision;
      const due = pendingReminder(payload.agent, payload.step);
      if (!due) return decision;
      return { ...decision, messages: [...decision.messages, reminderMessage(due.text, due.summary)] };
    } catch (error) {
      ctx.logger?.error?.("confirm-mode: reminder injection failed", error);
      return decision;
    }
  });
}

export { apply, inject, name };
