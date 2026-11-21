import { buildHarness } from "./harness.js";
import { interpretPayload, projectLabel } from "./result.js";

const DEFAULT_TIMEOUT_MS = 30_000;

// One After Effects panel connection (or a small set of zombie CEP sockets).
// The relay keeps one PanelLink per pairing token. The stdio server keeps one.
export class PanelLink {
  constructor({ blockMs = 4000, watchMs = 1000, replaceSockets = false } = {}) {
    this.blockMs = blockMs;
    this.watchMs = watchMs;
    this.replaceSockets = replaceSockets;
    this.sockets = [];
    this.project = null;
    this.aeVersion = null;
    this.wsError = null;
    this.blocked = false;
    this.blockedSince = null;
    this.lastHeartbeat = 0;
    this.pending = new Map();
    this.nextId = 1;
    this._timer = null;
    this.panelId = null;
  }

  get socket() {
    if (!this.sockets.length) return null;
    let best = this.sockets[0];
    for (const s of this.sockets) {
      if ((s.__lastMsg || 0) >= (best.__lastMsg || 0)) best = s;
    }
    return best;
  }

  hasLiveSocket() {
    return this.sockets.some((s) => s.readyState === 1);
  }

  addSocket(sock) {
    if (this.replaceSockets) {
      for (const old of this.sockets) {
        try { old.close(4000, "replaced by a new connection"); } catch { /* ignore */ }
      }
      this.sockets = [];
    }
    this.sockets.push(sock);
    sock.__lastMsg = Date.now();
    this.lastHeartbeat = Date.now();
    // A fresh connection means the main thread answered; clear a stale block
    // only after a real heartbeat message, not merely TCP open.

    sock.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      this.onMessage(sock, msg);
    });
    sock.on("close", () => {
      const idx = this.sockets.indexOf(sock);
      if (idx !== -1) this.sockets.splice(idx, 1);
      if (this.sockets.length === 0) {
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.resolve({ __transportError: "panel disconnected mid-call" });
          this.pending.delete(id);
        }
      }
    });
    sock.on("error", () => {});
  }

  onMessage(sock, msg) {
    sock.__lastMsg = Date.now();
    this.lastHeartbeat = Date.now();
    if (msg.type === "hello" || msg.type === "status") {
      if (msg.project !== undefined) this.project = msg.project;
      if (msg.aeVersion) this.aeVersion = msg.aeVersion;
    } else if (msg.type === "result") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg.payload);
    }
  }

  tick() {
    if (!this.socket) return;
    const gap = Date.now() - this.lastHeartbeat;
    if (!this.blocked && this.pending.size === 0 && this.lastHeartbeat && gap > this.blockMs) {
      this.blocked = true;
      this.blockedSince = Date.now();
      try { this.socket.send(JSON.stringify({ type: "ui_blocked" })); } catch { /* ignore */ }
    } else if (this.blocked && gap <= this.blockMs) {
      this.blocked = false;
      this.blockedSince = null;
      try { this.socket.send(JSON.stringify({ type: "ui_unblocked" })); } catch { /* ignore */ }
    }
  }

  startWatchdog() {
    if (this._timer) return;
    this._timer = setInterval(() => this.tick(), this.watchMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    for (const s of this.sockets) {
      try { s.close(1000, "bridge shutting down"); } catch { /* ignore */ }
    }
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ __transportError: "bridge shutting down" });
      this.pending.delete(id);
    }
  }

  snapshot() {
    return {
      connected: !!this.socket && this.socket.readyState === 1,
      project: this.project,
      aeVersion: this.aeVersion,
      blocked: this.blocked,
      blockedSince: this.blockedSince,
      panelId: this.panelId,
      wsError: this.wsError,
    };
  }

  async exec(jsx, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!this.socket || this.socket.readyState !== 1) {
      return {
        ok: false,
        stage: "connect",
        error: this.wsError
          ? `panel link unavailable: ${this.wsError}`
          : "Comfy AE Bridge panel is not connected. Open After Effects, then Window > Extensions > Comfy AE Bridge, and leave the panel open.",
        project: projectLabel(this.project),
      };
    }
    if (this.blocked) {
      return {
        ok: false,
        stage: "dialog",
        error: "After Effects is blocked by a modal or error dialog. Dismiss it in AE, then retry.",
        project: projectLabel(this.project),
      };
    }

    const id = this.nextId++;
    const nativeJson = parseFloat(this.aeVersion) >= 16;
    const harness = buildHarness({ includePolyfill: !nativeJson });
    const payload = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ __timeout: true, timeoutMs });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        this.socket.send(JSON.stringify({ type: "eval", id, userJsx: jsx, harness }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ __transportError: `failed to send eval: ${e.message}` });
      }
    });
    return interpretPayload(payload, this.project, { readSpill: true });
  }
}

export { DEFAULT_TIMEOUT_MS };
