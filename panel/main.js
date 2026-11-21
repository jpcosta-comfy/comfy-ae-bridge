// CEP panel. Dials the relay (or the local stdio daemon) and runs evals.
// Business logic stays on the MCP server. This file is the pipe, the watchdog
// heartbeat, and the pairing UI.

var POLL_MS = 1500;
var dotEl = document.getElementById("dot");
var stateEl = document.getElementById("state");
var projectEl = document.getElementById("project");
var relayEl = document.getElementById("relay");
var codeEl = document.getElementById("code");
var toastEl = document.getElementById("toast");
var relayFields = document.getElementById("relay-fields");
var localNote = document.getElementById("local-note");
var hintEl = document.getElementById("hint");

var mode = storeGet("cab-mode") || "relay";
var relayWs = storeGet("cab-relay") || DEFAULT_RELAY_WS;
var token = storeGet("cab-token") || newToken();
var panelId = storeGet("cab-panel") || newToken();
storeSet("cab-token", token);
storeSet("cab-panel", panelId);

var sock = null;
var backoff = 250;
var pollPending = false;
var toastTimer = null;

relayEl.value = relayWs;
renderCode();
applyMode();

document.getElementById("reload").onclick = function () {
  try { if (sock) sock.close(); } catch (e) {}
  location.reload();
};
document.getElementById("mode-relay").onclick = function () { setMode("relay"); };
document.getElementById("mode-local").onclick = function () { setMode("local"); };
document.getElementById("copy").onclick = function () { copyText(connectorUrl()); flash("Connector URL copied"); };
document.getElementById("rotate").onclick = function () {
  token = newToken();
  storeSet("cab-token", token);
  renderCode();
  flash("New code. The previous connector URL no longer works.");
  reconnect();
};
codeEl.onclick = function () { copyText(formatToken(token)); flash("Pairing code copied"); };
relayEl.onchange = function () {
  var next = relayEl.value.replace(/^\s+|\s+$/g, "");
  if (!next) return;
  relayWs = next;
  storeSet("cab-relay", relayWs);
  flash("Relay saved");
  if (mode === "relay") reconnect();
};

function setMode(next) {
  mode = next;
  storeSet("cab-mode", mode);
  applyMode();
  reconnect();
}

function applyMode() {
  document.getElementById("mode-relay").className = mode === "relay" ? "active" : "";
  document.getElementById("mode-local").className = mode === "local" ? "active" : "";
  relayFields.style.display = mode === "relay" ? "" : "none";
  localNote.style.display = mode === "local" ? "" : "none";
  hintEl.style.display = mode === "relay" ? "" : "none";
}

function renderCode() { codeEl.textContent = formatToken(token); }

function formatToken(raw) {
  var t = String(raw).replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return t.replace(/(.{4})(?=.)/g, "$1-");
}

function newToken() {
  var alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  var bytes = new Uint8Array(12);
  if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  var out = "";
  for (var j = 0; j < bytes.length; j++) out += alphabet[bytes[j] % alphabet.length];
  return out;
}

function connectorUrl() {
  var httpOrigin = relayWs
    .replace(/^wss:/i, "https:")
    .replace(/^ws:/i, "http:")
    .replace(/\/ws\/?$/, "");
  return httpOrigin + "/mcp/" + formatToken(token);
}

function storeGet(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function storeSet(key, value) {
  try { localStorage.setItem(key, value); } catch (e) {}
}

function flash(text) {
  toastEl.textContent = text;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastEl.textContent = ""; }, 2500);
}

function copyText(text) {
  var ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch (e) {}
  document.body.removeChild(ta);
}

function evalScript(script, cb) {
  if (window.__adobe_cep__ && window.__adobe_cep__.evalScript) {
    window.__adobe_cep__.evalScript(script, cb);
  } else if (cb) {
    cb("EvalScript error.");
  }
}

function escapeJsxPath(p) {
  return String(p).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function nodeRequire(name) {
  try {
    if (typeof require === "function") return require(name);
  } catch (e) {}
  return null;
}

function send(obj) {
  if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(obj));
}

function setUI(connected, project) {
  if (connected === "warn") {
    dotEl.className = "warn";
    stateEl.textContent = "AE is blocked — close the dialog";
    return;
  }
  dotEl.className = connected ? "on" : "";
  stateEl.textContent = connected ? (mode === "relay" ? "paired with relay" : "connected to local daemon") : "offline — retrying";
  if (project !== undefined) projectEl.textContent = project || "(no project file)";
}

var STATE_JSX =
  '(function(){var d=false;try{app.beginSuppressDialogs();d=true;}catch(e0){}' +
  'try{' +
  'var p=(app.project&&app.project.file)?app.project.file.fsName:"";' +
  'return p+"\\u0002"+app.version;' +
  '}catch(e){return "";}' +
  'finally{if(d){try{app.endSuppressDialogs(false);}catch(e1){}}}})()';

function pollState(type) {
  if (pollPending) return;
  pollPending = true;
  evalScript(STATE_JSX, function (res) {
    pollPending = false;
    var parts = String(res || "").split("\u0002");
    var project = parts[0] || "";
    send({ type: type || "status", project: project, aeVersion: parts[1] || "" });
    if (dotEl.className !== "warn") setUI(true, project);
  });
}

function finishResult(id, result) {
  send({ type: "result", id: id, payload: result });
}

function handleEval(msg) {
  var fs = nodeRequire("fs");
  var pathMod = nodeRequire("path");
  var os = nodeRequire("os");
  if (fs && pathMod && os) {
    try {
      var dir = pathMod.join(os.tmpdir(), "comfy-ae-bridge");
      fs.mkdirSync(dir, { recursive: true });
      var userPath = pathMod.join(dir, "user-" + msg.id + ".jsx");
      var spillPath = pathMod.join(dir, "result-" + msg.id + ".json");
      var harnessPath = pathMod.join(dir, "harness-" + msg.id + ".jsx");
      fs.writeFileSync(userPath, msg.userJsx, "utf8");
      var harness = String(msg.harness)
        .split("__USER_PATH__").join(escapeJsxPath(userPath))
        .split("__SPILL_PATH__").join(escapeJsxPath(spillPath));
      fs.writeFileSync(harnessPath, harness, "utf8");
      evalScript('$.evalFile("' + escapeJsxPath(harnessPath) + '")', function (result) {
        if (result && String(result).indexOf("__file") !== -1) {
          try {
            var meta = JSON.parse(result);
            if (meta && meta.__file && fs.existsSync(meta.__file)) {
              result = fs.readFileSync(meta.__file, "utf8");
              try { fs.unlinkSync(meta.__file); } catch (e1) {}
            }
          } catch (e2) {}
        }
        try { fs.unlinkSync(userPath); } catch (e3) {}
        try { fs.unlinkSync(harnessPath); } catch (e4) {}
        finishResult(msg.id, result);
      });
      return;
    } catch (err) {
      /* fall through to the ExtendScript writer */
    }
  }
  evalScript(buildExtendScriptCall(msg), function (result) {
    finishResult(msg.id, result);
  });
}

function socketUrl() {
  if (mode === "local") return LOCAL_DAEMON_WS;
  var base = relayWs.replace(/\?.*$/, "").replace(/\/$/, "");
  var join = base.indexOf("?") === -1 ? "?" : "&";
  return base + join + "token=" + encodeURIComponent(token) + "&panel=" + encodeURIComponent(panelId);
}

function connect() {
  var url = socketUrl();
  try { sock = new WebSocket(url); }
  catch (e) { setUI(false); setTimeout(connect, backoff); return; }
  sock.onopen = function () {
    backoff = 250;
    pollPending = false;
    pollState("hello");
  };
  sock.onmessage = function (ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === "eval") handleEval(msg);
    else if (msg.type === "ui_blocked") setUI("warn");
    else if (msg.type === "ui_unblocked") {
      dotEl.className = "on";
      stateEl.textContent = mode === "relay" ? "paired with relay" : "connected to local daemon";
    }
  };
  sock.onclose = function () {
    setUI(false);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 1.6, 4000);
  };
  sock.onerror = function () {
    try { sock.close(); } catch (e) {}
  };
}

function reconnect() {
  backoff = 250;
  try { if (sock) sock.close(); } catch (e) {}
}

setInterval(function () {
  if (sock && sock.readyState === WebSocket.OPEN) pollState();
}, POLL_MS);

connect();
