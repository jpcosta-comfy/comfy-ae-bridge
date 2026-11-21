// Comfy Cloud's run_template accepts client_os "darwin", not "macos".

export function clientOs(value, platform = process.platform) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "macos" || raw === "mac" || raw === "osx" || raw === "darwin") return "darwin";
  if (raw === "windows" || raw === "win" || raw === "win32") return "win32";
  if (raw === "linux") return "linux";
  if (platform === "darwin" || platform === "win32" || platform === "linux") return platform;
  return "linux";
}

export function normalizeClientOsArgs(args, platform = process.platform) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const next = { ...args };
  if (Object.prototype.hasOwnProperty.call(next, "client_os")) {
    next.client_os = clientOs(next.client_os, platform);
  }
  if (next.params && typeof next.params === "object" && !Array.isArray(next.params)) {
    next.params = { ...next.params };
    if (Object.prototype.hasOwnProperty.call(next.params, "client_os")) {
      next.params.client_os = clientOs(next.params.client_os, platform);
    }
  }
  return next;
}

export function roundUpToMultiple(value, multiple = 16) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.ceil(n / multiple) * multiple;
}
