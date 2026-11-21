// End-to-end: MCP client -> bridge -> fake panel (no After Effects).
// Covers the local stdio server and a Claude-style streamable HTTP call
// through the relay, including the error-stage contract.

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";
import { startRelay } from "../src/relay.js";

const deadline = setTimeout(() => {
  console.error("FAIL smoke timed out");
  process.exit(1);
}, 45_000);
deadline.unref?.();

let failed = 0;
function check(name, cond, extra = "") {
  console.log(cond ? "PASS" : "FAIL", name, extra);
  if (!cond) failed++;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function callTool(client, name, args) {
  return client.callTool({ name, arguments: args }).then((res) => JSON.parse(res.content[0].text));
}

function attachFake(ws, project) {
  const state = { lastUserJsx: "", heartbeats: true, evals: 0, project };
  const beat = setInterval(() => {
    if (!state.heartbeats || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "status", project: state.project, aeVersion: "26.3" }));
  }, 200);
  ws.on("close", () => clearInterval(beat));
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type !== "eval") return;
    state.evals += 1;
    state.lastUserJsx = msg.userJsx || "";
    const user = state.lastUserJsx;
    if (user.includes("HANG")) return;
    let payload;
    if (user.includes("THROW")) payload = '{"ok":false,"error":"ReferenceError: boom","line":3}';
    else if (user.includes("GARBAGE")) payload = "not json at all";
    else if (user.includes("BIG")) payload = JSON.stringify({ ok: true, value: { items: "x".repeat(100000) } });
    else if (user.includes("SPILLME")) {
      const spill = path.join(os.tmpdir(), `cab-smoke-${process.pid}.json`);
      fs.writeFileSync(spill, JSON.stringify({ ok: true, value: { via: "spill" } }));
      payload = JSON.stringify({ __file: spill });
    } else payload = '{"ok":true,"value":42}';
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "result", id: msg.id, payload }));
      }
    }, 30);
  });
  return state;
}

async function openFake(url, project) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const state = attachFake(ws, project);
  ws.send(JSON.stringify({ type: "hello", project, aeVersion: "26.3" }));
  return { ws, state };
}

async function smokeStdio() {
  console.log("\n-- stdio --");
  const port = await freePort();
  const project = "/tmp/Launch_Master.aep";
  const client = new Client({ name: "smoke-stdio", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [new URL("../src/stdio.js", import.meta.url).pathname],
    env: {
      ...process.env,
      AE_BRIDGE_PORT: String(port),
      AEBRIDGE_BLOCK_MS: "500",
      AEBRIDGE_WATCH_MS: "200",
    },
  });
  await client.connect(transport);
  try {
    let res = await callTool(client, "ae_exec", { jsx: "1+1" });
    check("stdio connect-stage", res.ok === false && res.stage === "connect", JSON.stringify(res.stage));

    const { ws, state } = await openFake(`ws://127.0.0.1:${port}`, project);
    await new Promise((r) => setTimeout(r, 150));

    res = await callTool(client, "ae_exec", { jsx: "1+41" });
    check("stdio happy-path", res.ok === true && res.result === 42 && res.project.includes("Launch_Master"), JSON.stringify(res));
    res = await callTool(client, "ae_exec", { jsx: "THROW" });
    check("stdio jsx-error", res.ok === false && res.stage === "eval" && res.error.includes("boom"));
    res = await callTool(client, "ae_exec", { jsx: "GARBAGE" });
    check("stdio parse-stage", res.ok === false && res.stage === "parse");
    res = await callTool(client, "ae_exec", { jsx: "BIG" });
    check("stdio large-result", res.ok === true && res.result.items.length === 100000);
    res = await callTool(client, "ae_exec", { jsx: "SPILLME" });
    check("stdio spill-file", res.ok === true && res.result.via === "spill");
    res = await callTool(client, "ae_exec", { jsx: "HANG", timeout_ms: 800 });
    check("stdio timeout-stage", res.ok === false && res.stage === "timeout");

    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);
    for (const name of ["ae_import", "ae_replace_source", "ae_relink_missing", "ae_layer_swap", "ae_render_queue_add", "ae_render_start", "ae_batch", "ae_survey", "ae_place_variants", "ae_move_to_corner"]) {
      check(`stdio lists ${name}`, names.includes(name));
    }

    state.heartbeats = false;
    await new Promise((r) => setTimeout(r, 1000));
    const blocked = await callTool(client, "ae_status", {});
    check("stdio dialog-detected", blocked.result?.blocked === true, JSON.stringify(blocked.result));
    res = await callTool(client, "ae_exec", { jsx: "1+1" });
    check("stdio dialog-blocked-call", res.ok === false && res.stage === "dialog");
    state.heartbeats = true;
    ws.send(JSON.stringify({ type: "status", project, aeVersion: "26.3" }));
    await new Promise((r) => setTimeout(r, 500));
    const cleared = await callTool(client, "ae_status", {});
    check("stdio dialog-cleared", cleared.result?.blocked === false);

    ws.close();
  } finally {
    await client.close();
  }
}

async function smokeRelay() {
  console.log("\n-- relay --");
  const relay = await startRelay({
    host: "127.0.0.1",
    port: 0,
    blockMs: 500,
    watchMs: 200,
  });
  const base = `http://127.0.0.1:${relay.port}`;
  const token = "AB3K-9QMP-X7WD";
  const project = "/tmp/Brand_Fix.aep";
  try {
    const health = await fetch(`${base}/health`).then((r) => r.json());
    check("relay health", health.ok === true && health.service === "comfy-ae-bridge");

    const missing = await fetch(`${base}/mcp/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    check("relay rejects unknown token", missing.status === 401);

    const { ws, state } = await openFake(
      `ws://127.0.0.1:${relay.port}/ws?token=${encodeURIComponent(token)}&panel=panel-a`,
      project,
    );
    await new Promise((r) => setTimeout(r, 150));

    const intruder = new WebSocket(`ws://127.0.0.1:${relay.port}/ws?token=${encodeURIComponent(token)}&panel=panel-b`);
    const intruderCode = await new Promise((resolve) => {
      intruder.once("close", (code) => resolve(code));
      intruder.once("error", () => resolve(0));
    });
    check("relay one panel per token", intruderCode === 4001, `code=${intruderCode}`);

    const client = new Client({ name: "smoke-relay", version: "0.0.0" });
    const httpTransport = new StreamableHTTPClientTransport(new URL(`${base}/mcp/${token}`));
    await client.connect(httpTransport);
    try {
      let res = await callTool(client, "ae_exec", { jsx: "1+41" });
      check("relay happy-path", res.ok === true && res.result === 42 && res.project.includes("Brand_Fix"), JSON.stringify(res));

      res = await callTool(client, "ae_place_variants", {
        template_comp: "Launch_Master",
        placeholder_layer: "MEDIA",
        assets: [{ url: "https://example.com/hero.mp4", label: "hero" }, { path: "/tmp/still.png", label: "still" }],
        aspects: ["16:9", "9:16", "1:1"],
        output_dir: "/tmp/renders",
      });
      check(
        "relay place-variants reaches panel",
        res.ok === true
          && state.lastUserJsx.includes("Launch_Master")
          && state.lastUserJsx.includes("https://example.com/hero.mp4")
          && state.lastUserJsx.includes("[1920,1080]")
          && state.lastUserJsx.includes("[1080,1920]")
          && state.lastUserJsx.includes("[1080,1080]"),
      );
      check("relay place-variants jsx has every aspect", state.lastUserJsx.includes("16:9") && state.lastUserJsx.includes("9:16") && state.lastUserJsx.includes("1:1"));

      res = await callTool(client, "ae_survey", {});
      check("relay survey reaches panel", res.ok === true && state.lastUserJsx.includes("Source Text"));

      res = await callTool(client, "ae_move_to_corner", { layer: "LOGO", corner: "BR", margin: 48 });
      check("relay move-to-corner reaches panel", res.ok === true && state.lastUserJsx.includes("LOGO") && state.lastUserJsx.includes("BR"));

      res = await callTool(client, "ae_batch", { ops: ["1", "2"] });
      check("relay batch reaches panel", res.ok === true && state.lastUserJsx.includes("ARGS.ops"));

      const resource = await client.readResource({ uri: "aebridge://status" });
      const snap = JSON.parse(resource.contents[0].text);
      check("relay status resource", snap.connected === true && snap.project === project);

      state.heartbeats = false;
      await new Promise((r) => setTimeout(r, 1000));
      res = await callTool(client, "ae_exec", { jsx: "1" });
      check("relay dialog-blocked-call", res.ok === false && res.stage === "dialog", JSON.stringify(res));
      state.heartbeats = true;
      ws.send(JSON.stringify({ type: "status", project, aeVersion: "26.3" }));
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      await client.close();
    }

    const bearer = new Client({ name: "smoke-bearer", version: "0.0.0" });
    const bearerTransport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await bearer.connect(bearerTransport);
    try {
      const res = await callTool(bearer, "ae_exec", { jsx: "1+41" });
      check("relay bearer auth", res.ok === true && res.result === 42);
    } finally {
      await bearer.close();
    }

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    const client2 = new Client({ name: "smoke-offline", version: "0.0.0" });
    const offline = new StreamableHTTPClientTransport(new URL(`${base}/mcp/${token}`));
    await client2.connect(offline);
    try {
      const res = await callTool(client2, "ae_exec", { jsx: "1" });
      check("relay connect-stage after panel drop", res.ok === false && res.stage === "connect", res.stage);
    } finally {
      await client2.close();
    }
  } finally {
    await relay.close();
  }
}

try {
  await smokeStdio();
  await smokeRelay();
} catch (err) {
  failed++;
  console.error("FAIL smoke threw", err);
}

clearTimeout(deadline);
if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nsmoke ok");
process.exit(0);
