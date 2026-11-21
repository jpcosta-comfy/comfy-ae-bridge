#!/usr/bin/env node
// Local entry. Claude Code speaks MCP on stdio.
// Default transport is direct: osascript on macOS, AfterFX -r on Windows.
// COMFY_AE_TRANSPORT=auto|direct|panel. auto uses direct when AE is installed
// and the panel socket otherwise. Stdout is MCP only.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { PanelLink } from "./panel-link.js";
import { buildMcpServer } from "./server.js";
import { chooseTransport, detectDirectTarget, execDirect } from "./direct.js";
import { projectLabel as labelOf } from "./result.js";

const port = Number(process.env.AE_BRIDGE_PORT || 9227);
const target = detectDirectTarget();
const transport = chooseTransport(process.env.COMFY_AE_TRANSPORT, target);
const panel = new PanelLink({
  blockMs: Number(process.env.AEBRIDGE_BLOCK_MS || 4000),
  watchMs: Number(process.env.AEBRIDGE_WATCH_MS || 1000),
  replaceSockets: false,
});

const log = (...args) => console.error("[comfy-ae-bridge]", ...args);

const wss = new WebSocketServer({ host: "127.0.0.1", port });
wss.on("error", (err) => {
  panel.wsError = String(err);
  log("websocket error:", err.message, err.code === "EADDRINUSE" ? "(port in use)" : "");
});
wss.on("listening", () => log(`local panel socket on 127.0.0.1:${port}`));
wss.on("connection", (sock) => {
  log("panel connected");
  panel.addSocket(sock);
  sock.on("close", () => log("panel disconnected"));
});
panel.startWatchdog();

const bridge = {
  async exec(jsx, timeoutMs) {
    if (transport === "panel") return panel.exec(jsx, timeoutMs);
    if (!target) {
      return {
        ok: false,
        stage: "connect",
        error: "COMFY_AE_TRANSPORT=direct but no After Effects install was found. Set AE_APP_NAME (macOS application name) or AE_APP_PATH (Windows AfterFX.exe).",
        project: labelOf(null),
      };
    }
    return execDirect(jsx, timeoutMs ?? 30_000, { target });
  },
  snapshot() {
    const panelSnap = panel.snapshot();
    if (transport === "direct") {
      return {
        transport: "direct",
        connected: !!target,
        project: null,
        projectInfo: null,
        aeApp: target?.appName || target?.exe || null,
        aeVersion: null,
        blocked: false,
        panelConnected: panelSnap.connected,
        windowsDirectUntested: target?.platform === "win32",
      };
    }
    return {
      transport: "panel",
      directAvailable: !!target,
      ...panelSnap,
    };
  },
  async inspectProject() {
    const base = this.snapshot();
    if (transport !== "direct" || !target) return base;
    const res = await execDirect(
      "(function(){var info={open:false,saved:false,path:\"\",name:\"\",numItems:0,activeComp:null};if(!app.project)return info;info.open=true;info.numItems=app.project.numItems;if(app.project.file){info.saved=true;info.path=app.project.file.fsName;info.name=app.project.file.name;}else{info.name=\"(unsaved project)\";}var active=app.project.activeItem;if(active&&(active instanceof CompItem)){info.activeComp={name:active.name,id:active.id,width:active.width,height:active.height};}return info;})();",
      20_000,
      { target },
    );
    const info = res.projectInfo?.open ? res.projectInfo : (res.ok ? res.result : null);
    return {
      ...base,
      connected: res.stage !== "connect",
      project: info?.path || (info?.open ? info.name : null),
      projectInfo: info,
      saved: info?.saved ?? null,
      numItems: info?.numItems ?? null,
      activeComp: info?.activeComp ?? null,
      stage: res.ok ? undefined : res.stage,
      error: res.ok ? undefined : res.error,
    };
  },
};

if (transport === "direct" && target) {
  log(`direct transport via ${target.appName || target.exe}${target.untested ? " (untested on Windows)" : ""}`);
} else if (transport === "direct") {
  log("direct transport requested, but no After Effects install was found");
} else {
  log(`panel transport${target ? ` (${target.appName || target.exe} is installed; set COMFY_AE_TRANSPORT=direct to use it)` : " (no After Effects install found)"}`);
}

const server = await buildMcpServer(bridge);
await server.connect(new StdioServerTransport());
log("stdio MCP ready");
