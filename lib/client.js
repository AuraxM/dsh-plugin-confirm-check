window.__ModuleLoader__.load({
  id: "dsh-confirm-mode",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let React = require("react");
    require("@deepseek-ai/dsh-api-remotes");

    var css = ".cmt-tgl{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1,#3a3f47);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6);font-size:11px;line-height:1;cursor:pointer;flex:none}" +
      ".cmt-tgl:hover{border-color:var(--dsw-alias-border-l2,#565d68);color:var(--dsw-alias-label-primary,#e6e8eb)}" +
      ".cmt-tgl:disabled{opacity:.55;cursor:default}" +
      ".cmt-dot{width:7px;height:7px;border-radius:50%;flex:none}" +
      ".cmt-tgl.cmt-on .cmt-dot{background:var(--dsw-alias-state-success-primary,#2e7d32)}" +
      ".cmt-tgl.cmt-off .cmt-dot{background:var(--dsw-alias-state-warn-primary,#9a6700)}";
    // Stopgap for the harness's generic question card: it renders a question's
    // markdown `detail` with `margin: 0 2px` inside an unpadded body, so a mission
    // plan hugs the card's rounded edge while the card's header sits at 24px and its
    // option list at 12px. 16px puts the detail between them. The selector is
    // structural - the body's first child, which (unlike the option list) carries no
    // role - so a harness class-name change only makes this rule stop matching.
    // Delete it once the harness pads that block itself.
    css += "[data-question-scroll]>div:first-child:not([role]){margin-left:16px;margin-right:16px}";
    var tagId = "dsh-confirm-mode/confirm-mode.css";
    if (typeof document !== "undefined") {
      // One tag per document, rewritten on every load: a hot-reloaded client half
      // must never keep rendering with the previous stylesheet.
      var tag = document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]");
      if (tag === null) {
        tag = document.createElement("style");
        tag.dataset.plugin = "dsh-confirm-mode";
        tag.dataset.pluginCss = tagId;
        document.head.appendChild(tag);
      }
      tag.textContent = css;
    }

    function parseState(result) {
      if (!result || !result.ok || !result.value || !result.value.result || typeof result.value.result.text !== "string") return undefined;
      var first = result.value.result.text.split(" ")[0];
      if (first === "on") return true;
      if (first === "off") return false;
      return undefined;
    }

    function Toggle(props) {
      var onState = React.useState(true);
      var on = onState[0];
      var setOn = onState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      React.useEffect(function () {
        var alive = true;
        props.readState().then(function (state) {
          if (alive && typeof state === "boolean") setOn(state);
        }, function () {});
        return function () { alive = false; };
      }, []);

      var click = function () {
        if (busy) return;
        setBusy(true);
        props.toggle().then(function (state) {
          if (typeof state === "boolean") setOn(state);
          setBusy(false);
        }, function () { setBusy(false); });
      };

      var title = on
        ? "Confirm Mode: on. One permission application is required before permanent changes (code edits, git commits, ...); reads and plan/note writes need none. Click to turn off."
        : "Confirm Mode: off. Direction monitoring and permission reminders are disabled. Click to turn on.";

      return React.createElement("button",
        { type: "button", className: "cmt-tgl" + (on ? " cmt-on" : " cmt-off"), title: title, disabled: busy, onClick: click },
        React.createElement("span", { className: "cmt-dot" }),
        React.createElement("span", null, "Confirm Mode: " + (on ? "on" : "off"))
      );
    }

    function apply(ctx) {
      ctx.slots.inject("conversation.input.left", function () {
        return ctx.slots.register({
          name: "conversation.input.left",
          id: "confirm-mode-toggle",
          order: 0,
          label: "Confirm Mode toggle"
        }, function (props) {
          var sessionId = props.sessionId;
          return React.createElement(Toggle, {
            sessionId: sessionId,
            readState: function () {
              return ctx.remote.commands.execute(sessionId, "/confirm-mode status", []).then(parseState, function () { return undefined; });
            },
            toggle: function () {
              return ctx.remote.commands.execute(sessionId, "/confirm-mode toggle", []).then(parseState, function () { return undefined; });
            }
          });
        });
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "remote", "remote.commands"];
    return module.exports;
  }
});
