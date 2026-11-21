// Pairing codes are shown to people as groups (AB3K-9QMP-X7WD) and travel
// on the wire without punctuation. Comparison is case-insensitive.

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function normalizeToken(raw) {
  return String(raw || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

export function formatToken(raw) {
  const t = normalizeToken(raw);
  return t.replace(/(.{4})(?=.)/g, "$1-");
}

export function tokenOk(raw) {
  const t = normalizeToken(raw);
  return t.length >= 8 && t.length <= 64;
}

export function generateToken(bytes = 12) {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < bytes; i++) out += ALPHABET[buf[i] % ALPHABET.length];
  return out;
}

export function maskToken(raw) {
  const t = normalizeToken(raw);
  if (t.length <= 4) return "****";
  return `…${t.slice(-4)}`;
}
