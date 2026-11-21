// ExtendScript harness around a user script.
// Everything emitted here is ES3. No let/const, arrows, or Array extras.
// The panel writes the user script and this harness to temp files on the
// After Effects machine, then substitutes __USER_PATH__ and __SPILL_PATH__.

const JSON_POLYFILL = String.raw`
if (typeof JSON === "undefined") { JSON = {}; }
if (!JSON.stringify) {
  JSON.stringify = function (root) {
    function esc(s) {
      s = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
           .replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
      var out = "";
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c < 32) {
          var h = c.toString(16);
          out += "\\u" + ("0000" + h).slice(-4);
        } else {
          out += s.charAt(i);
        }
      }
      return '"' + out + '"';
    }
    function go(x) {
      if (x === null || x === undefined) return "null";
      var t = typeof x;
      if (t === "number") return isFinite(x) ? String(x) : "null";
      if (t === "boolean") return String(x);
      if (t === "string") return esc(x);
      if (x instanceof Array) {
        var a = [];
        for (var i = 0; i < x.length; i++) a.push(go(x[i]));
        return "[" + a.join(",") + "]";
      }
      if (t === "object") {
        var p = [];
        for (var k in x) if (x.hasOwnProperty(k)) p.push(esc(k) + ":" + go(x[k]));
        return "{" + p.join(",") + "}";
      }
      return "null";
    }
    return go(root);
  };
}
if (!JSON.parse) {
  JSON.parse = function (s) { return eval("(" + s + ")"); };
}
`;

// evalScript's return channel is unhappy with very large strings. The harness
// spills those to a file; the panel reads that file and sends the body back.
export const INLINE_RESULT_LIMIT = 65536;

export function escapeJsxPath(p) {
  return String(p).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Shared by the panel harness and the panel-less direct wrapper.
// Dialogs stay suppressed, pickers and alert() throw, and app.activate is a no-op
// for the length of the call. Restored in finally, including endSuppressDialogs(false).
const QUIET_OPEN = `
  var __res = { ok: true };
  var __suppressed = false;
  var __prev = {};
  function __keep(obj, key) {
    try { __prev[key] = obj[key]; } catch (eK) {}
  }
  function __put(obj, key, fn) {
    try { obj[key] = fn; } catch (eP) {}
  }
  function __projectInfo() {
    var info = { open: false, saved: false, path: "", name: "", numItems: 0, activeComp: null };
    try {
      if (!app.project) return info;
      info.open = true;
      info.numItems = app.project.numItems;
      if (app.project.file) {
        info.saved = true;
        info.path = app.project.file.fsName;
        info.name = app.project.file.name;
      } else {
        info.name = "(unsaved project)";
      }
      var active = app.project.activeItem;
      if (active && typeof CompItem !== "undefined" && (active instanceof CompItem)) {
        info.activeComp = { name: active.name, id: active.id, width: active.width, height: active.height };
      }
    } catch (eInfo) {}
    return info;
  }
  __keep(this, "alert");
  __keep(this, "confirm");
  __keep(this, "prompt");
  __keep(File, "openDialog");
  __keep(File, "saveDialog");
  __keep(Folder, "selectDialog");
  __keep(app, "activate");
  __keep(app, "beginSuppressDialogs");
  __keep(app, "endSuppressDialogs");
  try { app.beginSuppressDialogs(); __suppressed = true; } catch (eS) {}
  __put(this, "alert", function (msg) { throw new Error("alert: " + msg); });
  __put(this, "confirm", function (msg) { throw new Error("confirm: " + msg); });
  __put(this, "prompt", function (msg) { throw new Error("prompt: " + msg); });
  __put(File, "openDialog", function () { throw new Error("File.openDialog is disabled. Pass a path."); });
  __put(File, "saveDialog", function () { throw new Error("File.saveDialog is disabled. Pass a path."); });
  __put(Folder, "selectDialog", function () { throw new Error("Folder.selectDialog is disabled. Pass a path."); });
  __put(app, "activate", function () {});
  __put(app, "beginSuppressDialogs", function () {});
  __put(app, "endSuppressDialogs", function () {});
  try {
    __res.value = $.evalFile("__USER_PATH__");
    if (__res.value === undefined) __res.value = null;
    __res.projectInfo = __projectInfo();
    __res.project = __res.projectInfo.path || (__res.projectInfo.open ? __res.projectInfo.name : "");
  } catch (e) {
    __res.ok = false;
    __res.error = String(e);
    if (e && e.line) __res.line = e.line;
    __res.projectInfo = __projectInfo();
    __res.project = __res.projectInfo.path || (__res.projectInfo.open ? __res.projectInfo.name : "");
  } finally {
    __put(this, "alert", __prev.alert);
    __put(this, "confirm", __prev.confirm);
    __put(this, "prompt", __prev.prompt);
    __put(File, "openDialog", __prev.openDialog);
    __put(File, "saveDialog", __prev.saveDialog);
    __put(Folder, "selectDialog", __prev.selectDialog);
    __put(app, "activate", __prev.activate);
    __put(app, "beginSuppressDialogs", __prev.beginSuppressDialogs);
    __put(app, "endSuppressDialogs", __prev.endSuppressDialogs);
    if (__suppressed) {
      try { app.endSuppressDialogs(false); } catch (eE) {}
    }
  }
`;

/**
 * Panel harness. Returns a JSON string to evalScript, spilling to __SPILL_PATH__
 * when the string is large.
 * @param {{ includePolyfill?: boolean }} [opts]
 */
export function buildHarness(opts = {}) {
  const includePolyfill = opts.includePolyfill !== false;
  const big = "__SPILL_PATH__";
  return `(function () {
${includePolyfill ? JSON_POLYFILL : ""}
${QUIET_OPEN}
  var __out;
  try {
    __out = JSON.stringify(__res);
  } catch (e2) {
    __out = '{"ok":false,"error":"result not serializable: ' +
      String(e2).replace(/\\\\/g, "").replace(/"/g, "'") + '"}';
  }
  if (__out.length > ${INLINE_RESULT_LIMIT}) {
    var __f = new File("${big}");
    __f.encoding = "UTF-8";
    if (__f.open("w")) { __f.write(__out); __f.close(); __out = '{"__file":"${big}"}'; }
  }
  return __out;
})();`;
}

/**
 * Panel-less wrapper. The same quiet block as the panel harness, then the JSON
 * result is written to __RESULT_PATH__ for the stdio server to read back.
 * DoScriptFile's own return value is only a short marker.
 * @param {{ includePolyfill?: boolean }} [opts]
 */
export function buildDirectWrapper(opts = {}) {
  const includePolyfill = opts.includePolyfill !== false;
  return `(function () {
${includePolyfill ? JSON_POLYFILL : ""}
${QUIET_OPEN}
  var __out;
  try {
    __out = JSON.stringify(__res);
  } catch (e2) {
    __out = '{"ok":false,"error":"result not serializable: ' +
      String(e2).replace(/\\\\/g, "").replace(/"/g, "'") + '"}';
  }
  var __rf = new File("__RESULT_PATH__");
  __rf.encoding = "UTF-8";
  if (!__rf.open("w")) return '{"ok":false,"error":"could not write result file"}';
  __rf.write(__out);
  __rf.close();
  return "comfy-ae-bridge";
})();`;
}
