// Panel-less transport. The stdio server writes a wrapper .jsx and asks After
// Effects to run it. The wrapper writes JSON to a result file. macOS uses
// osascript DoScriptFile and never sends `activate`. Windows uses AfterFX -r
// and is untested here (this environment is Linux).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDirectWrapper, escapeJsxPath } from "./harness.js";
import { interpretPayload, projectLabel } from "./result.js";

export const AE_VERSIONS = ["2026", "2025", "2024", "2023", "2022", "2021", "2020"];

export function chooseTransport(mode, target) {
  const picked = String(mode || "auto").toLowerCase();
  if (picked === "panel") return "panel";
  if (picked === "direct") return "direct";
  return target ? "direct" : "panel";
}

export function detectDirectTarget({
  platform = process.platform,
  env = process.env,
  exists = fs.existsSync,
} = {}) {
  if (platform === "darwin") {
    const appName = env.AE_APP_NAME || findMacAppName(exists);
    if (!appName) return null;
    return { platform: "darwin", appName, runner: "osascript" };
  }
  if (platform === "win32") {
    const exe = env.AE_APP_PATH || findWindowsExe(env, exists);
    if (!exe) return null;
    return { platform: "win32", exe, runner: "afterfx", untested: true };
  }
  return null;
}

export function findMacAppName(exists) {
  for (const version of AE_VERSIONS) {
    const app = `/Applications/Adobe After Effects ${version}/Adobe After Effects ${version}.app`;
    if (exists(app)) return `Adobe After Effects ${version}`;
  }
  return null;
}

export function windowsCandidates(env = process.env) {
  const roots = [];
  if (env.ProgramFiles) roots.push(env.ProgramFiles);
  if (env["ProgramFiles(x86)"]) roots.push(env["ProgramFiles(x86)"]);
  if (!roots.includes("C:\\Program Files")) roots.push("C:\\Program Files");
  const out = [];
  for (const version of AE_VERSIONS) {
    for (const root of roots) {
      const base = `${root}\\Adobe\\Adobe After Effects ${version}\\Support Files\\`;
      // AfterFX.com is the console host and waits until the script returns.
      // AfterFX.exe is the GUI host. Both are untested on a real Windows AE.
      out.push(base + "AfterFX.com", base + "AfterFX.exe");
    }
  }
  return out;
}

export function findWindowsExe(env, exists) {
  for (const candidate of windowsCandidates(env)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function appleString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// `launch` starts AE if it is not running and does not bring it forward.
// There is no `activate` command. DoScriptFile is the whole event.
export function macAppleScript({ appName, jsxPath }) {
  return [
    `launch application ${appleString(appName)}`,
    `tell application ${appleString(appName)}`,
    `DoScriptFile (POSIX file ${appleString(jsxPath)})`,
    "end tell",
  ].join("\n");
}

// Untested. Adobe's documented switch is `-r <file.jsx>`.
export function windowsLaunch(exe, jsxPath) {
  return { command: exe, args: ["-r", jsxPath], untested: true };
}

export function isConnectError(err) {
  const msg = String(err && err.message ? err.message : err);
  return /1743|not authorized|not permitted|errAEEventNotPermitted|Automation|isn't running|Application isn't running|-600\b|ENOENT|osascript: command not found|no such file|not installed|cannot find/i.test(msg);
}

let chain = Promise.resolve();

function enqueue(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

/**
 * @param {string} jsx
 * @param {number} timeoutMs
 * @param {{ target: object, run?: Function, tmpDir?: string }} deps
 */
export function execDirect(jsx, timeoutMs, deps) {
  return enqueue(() => execDirectNow(jsx, timeoutMs, deps));
}

async function execDirectNow(jsx, timeoutMs, deps) {
  const dir = deps.tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), "comfy-ae-direct-"));
  const id = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const userPath = path.join(dir, `user-${id}.jsx`);
  const resultPath = path.join(dir, `result-${id}.json`);
  const wrapperPath = path.join(dir, `run-${id}.jsx`);
  const wrapper = buildDirectWrapper()
    .replaceAll("__USER_PATH__", escapeJsxPath(userPath))
    .replaceAll("__RESULT_PATH__", escapeJsxPath(resultPath));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(userPath, jsx, "utf8");
  fs.writeFileSync(wrapperPath, wrapper, "utf8");
  const run = deps.run || ((info) => defaultRun(deps.target, info));
  let text = null;
  try {
    await run({ wrapperPath, userPath, resultPath, timeoutMs, target: deps.target });
    if (!fs.existsSync(resultPath)) {
      return {
        ok: false,
        stage: "eval",
        error: "After Effects finished without writing a result file. The script may have been blocked before the wrapper could run.",
        project: projectLabel(null),
      };
    }
    text = fs.readFileSync(resultPath, "utf8");
  } catch (err) {
    if (err && (err.code === "TIMEOUT" || /timeout/i.test(err.message || ""))) {
      return interpretPayload({ __timeout: true, timeoutMs }, null);
    }
    const stage = isConnectError(err) ? "connect" : "eval";
    const hint = stage === "connect" && /1743|not authorized|not permitted/i.test(String(err.message))
      ? " macOS Automation blocked the call. Allow Claude Code (or Terminal) to control After Effects in System Settings > Privacy & Security > Automation, then retry."
      : "";
    return {
      ok: false,
      stage,
      error: String(err.message || err) + hint,
      project: projectLabel(null),
    };
  } finally {
    for (const file of [userPath, wrapperPath, resultPath]) {
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    }
  }
  return interpretPayload(text, null, { readSpill: true });
}

function defaultRun(target, info) {
  if (!target) {
    return Promise.reject(new Error("After Effects is not installed. Set AE_APP_NAME on macOS or AE_APP_PATH on Windows."));
  }
  if (target.runner === "osascript") return runOsascript(target, info);
  if (target.runner === "afterfx") return runAfterFx(target, info);
  return Promise.reject(new Error(`unknown direct runner: ${target.runner}`));
}

function runOsascript(target, { wrapperPath, timeoutMs }) {
  const source = macAppleScript({ appName: target.appName, jsxPath: wrapperPath });
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-"], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      const err = new Error(`no result within ${timeoutMs}ms`);
      err.code = "TIMEOUT";
      reject(err);
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `osascript exited ${code}`));
    });
    child.stdin.write(source);
    child.stdin.end();
  });
}

// Untested. Polls the result file because AfterFX.exe may return before the
// script finishes, and we must not kill the After Effects process.
function runAfterFx(target, { wrapperPath, resultPath, timeoutMs }) {
  const launch = windowsLaunch(target.exe, wrapperPath);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(launch.command, launch.args, { stdio: "ignore", windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setInterval(() => {
      if (fs.existsSync(resultPath)) {
        clearInterval(timer);
        resolve();
      }
    }, 150);
    const killer = setTimeout(() => {
      clearInterval(timer);
      const err = new Error(`no result within ${timeoutMs}ms`);
      err.code = "TIMEOUT";
      reject(err);
    }, timeoutMs);
    child.on("error", (err) => {
      clearInterval(timer);
      clearTimeout(killer);
      reject(err);
    });
    child.on("close", (code) => {
      if (fs.existsSync(resultPath)) {
        clearInterval(timer);
        clearTimeout(killer);
        resolve();
      } else if (code && code !== 0) {
        clearInterval(timer);
        clearTimeout(killer);
        reject(new Error(`AfterFX exited ${code} before writing a result (Windows direct transport is untested)`));
      }
    });
  });
}
