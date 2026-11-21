#!/usr/bin/env node
// Hosted relay. Claude (or any streamable-HTTP MCP client) calls /mcp/<token>
// or /mcp with Authorization: Bearer <token>. The After Effects panel dials
// out to /ws?token=&panel= and is the only socket allowed to own that token.
//
// Long-lived process on purpose. One Fly/Railway machine, not serverless.
// Deploy: fly deploy   (see fly.toml)   or   docker build && railway up.

import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PanelLink } from "./panel-link.js";
import { buildMcpServer, SERVER_VERSION } from "./server.js";
import { maskToken, normalizeToken, tokenOk } from "./tokens.js";

const log = (...args) => console.error("[comfy-ae-bridge]", ...args);

export async function startRelay(opts = {}) {
  const host = opts.host || process.env.HOST || "0.0.0.0";
  const port = Number(opts.port ?? process.env.PORT ?? 8787);
  const blockMs = Number(opts.blockMs ?? process.env.AEBRIDGE_BLOCK_MS ?? 4000);
  const watchMs = Number(opts.watchMs ?? process.env.AEBRIDGE_WATCH_MS ?? 1000);

  /** @type {Map<string, PanelLink>} */
  const links = new Map();
  /** @type {Map<string, { transport: any, server: any, token: string }>} */
  const mcpSessions = new Map();

  function linkFor(token) {
    const key = normalizeToken(token);
    if (!tokenOk(key)) return null;
    return links.get(key) || null;
  }

  const httpServer = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      log("http error:", err.message);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "relay error" }));
      } else {
        res.end();
      }
    }
  });
  // Renders block the HTTP request for minutes. Don't let Node cut them off.
  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 0;
  httpServer.timeout = 0;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "/", "http://localhost");
    const token = normalizeToken(url.searchParams.get("token"));
    const panelId = String(url.searchParams.get("panel") || "").slice(0, 80);
    if (!tokenOk(token) || !panelId) {
      ws.close(4002, "pairing token and panel id are required");
      return;
    }
    let link = links.get(token);
    if (!link) {
      link = new PanelLink({ blockMs, watchMs, replaceSockets: true });
      link.panelId = panelId;
      link.startWatchdog();
      links.set(token, link);
      log("panel paired", maskToken(token));
    } else if (link.panelId && link.panelId !== panelId && link.hasLiveSocket()) {
      log("rejected second panel", maskToken(token));
      ws.close(4001, "pairing token is in use by another panel");
      return;
    } else {
      link.panelId = panelId;
      log("panel reconnected", maskToken(token));
    }
    link.addSocket(ws);
  });

  async function route(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type, authorization, mcp-session-id, mcp-protocol-version, accept",
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      });
      res.end();
      return;
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        service: "comfy-ae-bridge",
        version: SERVER_VERSION,
        panels: links.size,
        mcp: "/mcp/<pairing-token>",
      }));
      return;
    }

    const mcp = parseMcp(req, url);
    if (!mcp) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const link = linkFor(mcp.token);
    if (!link) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: "unknown pairing token. Open the Comfy AE Bridge panel in After Effects and copy a fresh connector URL.",
      }));
      return;
    }

    const sessionHeader = header(req, "mcp-session-id");
    if (sessionHeader && mcpSessions.has(sessionHeader)) {
      const entry = mcpSessions.get(sessionHeader);
      if (entry.token !== normalizeToken(mcp.token)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "session does not match this pairing token" }));
        return;
      }
      const body = req.method === "POST" ? await readBody(req) : undefined;
      await entry.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "mcp session not found" }));
      return;
    }

    const body = await readBody(req);
    const mcpServer = await buildMcpServer(link);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        mcpSessions.set(id, { transport, server: mcpServer, token: normalizeToken(mcp.token) });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) mcpSessions.delete(transport.sessionId);
    };
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  log(`relay listening on http://${host}:${address.port}`);

  return {
    port: address.port,
    host,
    httpServer,
    links,
    async close() {
      for (const entry of mcpSessions.values()) {
        try { await entry.transport.close(); } catch { /* ignore */ }
        try { await entry.server.close(); } catch { /* ignore */ }
      }
      mcpSessions.clear();
      for (const link of links.values()) link.stop();
      links.clear();
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function header(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v || "";
}

function parseMcp(req, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "mcp") return null;
  const bearer = header(req, "authorization").match(/^Bearer\s+(\S+)/i);
  const fromPath = parts[1] ? decodeURIComponent(parts.slice(1).join("/")) : "";
  const token = normalizeToken(bearer?.[1] || fromPath);
  if (!token) return { token: "" };
  return { token };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 8_000_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const invokedDirectly = process.argv[1] && /relay\.js$/.test(process.argv[1]);
if (invokedDirectly) {
  startRelay().catch((err) => {
    console.error("[comfy-ae-bridge] failed to start:", err);
    process.exit(1);
  });
}
