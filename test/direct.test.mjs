import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import {
  AE_VERSIONS,
  appleString,
  chooseTransport,
  detectDirectTarget,
  execDirect,
  isConnectError,
  macAppleScript,
  windowsCandidates,
  windowsLaunch,
} from "../src/direct.js";
import { buildDirectWrapper, escapeJsxPath } from "../src/harness.js";

let failed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log("PASS", name))
    .catch((err) => {
      failed++;
      console.log("FAIL", name, err && err.stack ? err.stack : err);
    });
}

await check("auto prefers direct only when After Effects is installed", async () => {
  assert.equal(chooseTransport("auto", null), "panel");
  assert.equal(chooseTransport(undefined, null), "panel");
  assert.equal(chooseTransport("auto", { appName: "Adobe After Effects 2026" }), "direct");
  assert.equal(chooseTransport("panel", { appName: "Adobe After Effects 2026" }), "panel");
  assert.equal(chooseTransport("direct", null), "direct");
  assert.equal(chooseTransport("AUTO", { appName: "x" }), "direct");
  assert.equal(detectDirectTarget(), null);
});

await check("mac detection prefers the newest installed version and honors AE_APP_NAME", async () => {
  const installed = new Set([
    "/Applications/Adobe After Effects 2024/Adobe After Effects 2024.app",
    "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app",
  ]);
  const found = detectDirectTarget({
    platform: "darwin",
    env: {},
    exists: (p) => installed.has(p),
  });
  assert.equal(found.appName, "Adobe After Effects 2026");
  assert.equal(found.runner, "osascript");
  const override = detectDirectTarget({
    platform: "darwin",
    env: { AE_APP_NAME: "Adobe After Effects 2025" },
    exists: () => false,
  });
  assert.equal(override.appName, "Adobe After Effects 2025");
  assert.ok(AE_VERSIONS.includes("2025"));
});

await check("windows detection prefers AfterFX.com and honors AE_APP_PATH", async () => {
  const env = { ProgramFiles: "C:\\Program Files" };
  const com = "C:\\Program Files\\Adobe\\Adobe After Effects 2025\\Support Files\\AfterFX.com";
  assert.ok(windowsCandidates(env).includes(com));
  const found = detectDirectTarget({
    platform: "win32",
    env,
    exists: (p) => p === com,
  });
  assert.equal(found.exe, com);
  assert.equal(found.untested, true);
  const override = detectDirectTarget({
    platform: "win32",
    env: { AE_APP_PATH: "D:\\AE\\AfterFX.exe" },
    exists: () => false,
  });
  assert.equal(override.exe, "D:\\AE\\AfterFX.exe");
  assert.deepEqual(windowsLaunch(override.exe, "C:\\temp\\run.jsx"), {
    command: "D:\\AE\\AfterFX.exe",
    args: ["-r", "C:\\temp\\run.jsx"],
    untested: true,
  });
});

await check("mac applescript launches without activate", async () => {
  const script = macAppleScript({
    appName: 'Adobe After Effects "Beta"',
    jsxPath: "/tmp/comfy ae/run.jsx",
  });
  assert.match(script, /launch application "Adobe After Effects \\"Beta\\""/);
  assert.match(script, /DoScriptFile \(POSIX file "\/tmp\/comfy ae\/run\.jsx"\)/);
  assert.doesNotMatch(script, /\bactivate\b/);
  assert.equal(appleString('say "hi"'), '"say \\"hi\\""');
});

await check("permission errors are connect failures", async () => {
  assert.equal(isConnectError(new Error("Not authorized to send Apple events (-1743)")), true);
  assert.equal(isConnectError(new Error("After Effects got an error: 1")), false);
});

await check("direct wrapper writes a result file and returns alert as an error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cab-direct-wrap-"));
  const resultPath = path.join(dir, "result.json");
  const userPath = path.join(dir, "user.jsx");
  const wrapper = buildDirectWrapper({ includePolyfill: false })
    .replaceAll("__USER_PATH__", escapeJsxPath(userPath))
    .replaceAll("__RESULT_PATH__", escapeJsxPath(resultPath));
  assert.match(wrapper, /beginSuppressDialogs/);
  assert.match(wrapper, /endSuppressDialogs\(false\)/);
  assert.match(wrapper, /File\.openDialog is disabled/);
  assert.match(wrapper, /__put\(app, "activate", function \(\) \{\}\)/);
  const files = {};
  function File(p) { this.fsName = p; }
  File.openDialog = function () { throw new Error("REAL OPEN"); };
  File.saveDialog = function () { throw new Error("REAL SAVE"); };
  function Folder() {}
  Folder.selectDialog = function () { throw new Error("REAL SELECT"); };
  File.prototype.open = function () { return true; };
  File.prototype.write = function (s) { files[this.fsName] = s; };
  File.prototype.close = function () {};
  const context = {
    alert(msg) { throw new Error("REAL ALERT " + msg); },
    confirm() { throw new Error("REAL CONFIRM"); },
    prompt() { throw new Error("REAL PROMPT"); },
    File,
    Folder,
    ended: null,
    activated: 0,
    app: {
      beginSuppressDialogs() {},
      endSuppressDialogs(show) { context.ended = show; },
      activate() { context.activated += 1; },
      project: { file: { fsName: "/tmp/Launch_Master.aep" } },
    },
    $: {},
    JSON,
  };
  vm.createContext(context);
  vm.runInContext("$.evalFile = function () { app.activate(); alert('visible'); return 42; };", context);
  vm.runInContext(wrapper, context);
  const parsed = JSON.parse(files[resultPath]);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /alert: visible/);
  assert.equal(parsed.project, "/tmp/Launch_Master.aep");
  assert.equal(context.ended, false);
  assert.equal(context.activated, 0);
});

await check("mocked direct run returns eval errors and the open project", async () => {
  const target = { platform: "darwin", appName: "Adobe After Effects 2026", runner: "osascript" };
  async function run({ wrapperPath, userPath, resultPath }) {
    const wrapper = fs.readFileSync(wrapperPath, "utf8");
    const user = fs.readFileSync(userPath, "utf8");
    assert.match(wrapper, /endSuppressDialogs\(false\)/);
    assert.ok(wrapper.includes(escapeJsxPath(userPath)));
    const body = user.includes("THROW")
      ? { ok: false, error: "ReferenceError: boom", line: 3, project: "/tmp/Brand_Fix.aep" }
      : { ok: true, value: 42, project: "/tmp/Brand_Fix.aep" };
    fs.writeFileSync(resultPath, JSON.stringify(body));
  }
  const ok = await execDirect("1+41", 1000, { target, run });
  assert.equal(ok.ok, true);
  assert.equal(ok.result, 42);
  assert.match(ok.project, /Brand_Fix\.aep/);
  const bad = await execDirect("THROW", 1000, { target, run });
  assert.equal(bad.ok, false);
  assert.equal(bad.stage, "eval");
  assert.match(bad.error, /boom/);
  assert.match(bad.error, /line 3/);
});

await check("mocked direct run maps automation denial and timeout", async () => {
  const target = { platform: "darwin", appName: "Adobe After Effects 2026", runner: "osascript" };
  const denied = await execDirect("1", 1000, {
    target,
    run: async () => {
      throw new Error("Not authorized to send Apple events to Adobe After Effects 2026. (-1743)");
    },
  });
  assert.equal(denied.stage, "connect");
  assert.match(denied.error, /Automation/);
  const err = new Error("no result within 50ms");
  err.code = "TIMEOUT";
  const timed = await execDirect("HANG", 50, { target, run: async () => { throw err; } });
  assert.equal(timed.stage, "timeout");
  const missing = await execDirect("1", 1000, { target, run: async () => {} });
  assert.equal(missing.stage, "eval");
  assert.match(missing.error, /result file/);
});

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\ndirect ok");
