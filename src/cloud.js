// Comfy Cloud client used by the stdio server. Generation lives here so Claude
// does not need a second connector.
//
// Jobs and assets: Comfy API v2 (https://cloud.comfy.org/api/v2), Bearer auth.
// Templates, models, and credit balance: v1 cloud routes, X-API-Key.
// Docs: https://docs.comfy.org/api-reference/v2/overview

import fs from "node:fs";
import path from "node:path";

export const CLOUD_BASE = "https://cloud.comfy.org";

const MISSING_KEY =
  "COMFY_CLOUD_API_KEY is not set on the comfy-ae-bridge server. " +
  "Re-add it with: claude mcp add --scope user -e COMFY_CLOUD_API_KEY=YOUR_KEY --transport stdio comfy-ae-bridge -- node <REPO>/src/stdio.js. " +
  "Do not add a separate Comfy Cloud connector.";

export function requireApiKey(env = process.env) {
  const key = env.COMFY_CLOUD_API_KEY;
  if (!key || !String(key).trim()) {
    const err = new Error(MISSING_KEY);
    err.code = "MISSING_KEY";
    throw err;
  }
  return String(key).trim();
}

export function redact(text, key) {
  const raw = String(text ?? "");
  if (!key) return raw;
  return raw.split(key).join("[redacted]");
}

export function normalizeTemplates(data) {
  const rows = [];
  const push = (item, category) => {
    if (!item || typeof item !== "object") return;
    const name = item.name || item.title || item.id || item.filename;
    if (!name) return;
    rows.push({
      name: String(name),
      description: item.description || "",
      mediaType: item.mediaType || item.media_type || item.type || null,
      filename: item.filename || null,
      category: category || item.category || null,
      workflow: item.workflow || item.api_workflow || item.prompt || null,
    });
  };
  if (Array.isArray(data)) {
    for (const item of data) push(item);
  } else if (data && Array.isArray(data.templates)) {
    for (const item of data.templates) push(item);
  } else if (data && typeof data === "object") {
    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value)) {
        for (const item of value) push(typeof item === "string" ? { name: item } : item, key);
      } else if (value && typeof value === "object") {
        push(value, key);
      }
    }
  }
  return rows;
}

export function normalizeModels(data) {
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.models) ? data.models : []);
  return list.map((item) => {
    if (typeof item === "string") return { name: item };
    return {
      name: item.name || item.filename || item.path || item.model || "unknown",
      path: item.path || item.filename || null,
    };
  });
}

function isNegative(node) {
  const title = String(node?._meta?.title || node?.title || "").toLowerCase();
  return title.includes("negative");
}

function textKey(inputs) {
  if (!inputs || typeof inputs !== "object") return null;
  if (typeof inputs.text === "string") return "text";
  if (typeof inputs.prompt === "string") return "prompt";
  return null;
}

export function assetRef(id) {
  return { type: "core/ASSET", id };
}

/**
 * Patch an API-format workflow (node-id keys, class_type + inputs).
 * UI-format graphs ({ nodes, links }) are rejected by POST /api/v2/jobs.
 */
export function applyInputs(workflow, inputs = {}) {
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    throw new Error("workflow must be an API-format object keyed by node id");
  }
  if (Array.isArray(workflow.nodes) && workflow.links) {
    throw new Error("This is UI-format workflow JSON (nodes/links). Export API format and pass that. Comfy Cloud rejects UI format with workflow_format_ui.");
  }
  const graph = structuredClone(workflow);
  const imageIds = inputs.imageAssetIds || [];
  let imageCursor = 0;
  for (const node of Object.values(graph)) {
    if (!node || typeof node !== "object" || !node.inputs) continue;
    const inputsOf = node.inputs;
    const kind = String(node.class_type || "");
    if (inputs.prompt && !isNegative(node)) {
      const key = textKey(inputsOf);
      if (key && /text|clip|prompt/i.test(kind)) inputsOf[key] = inputs.prompt;
    }
    if (inputs.seed != null && Object.prototype.hasOwnProperty.call(inputsOf, "seed")) {
      inputsOf.seed = inputs.seed;
    }
    if (inputs.width && inputs.height && inputsOf.width != null && inputsOf.height != null) {
      inputsOf.width = inputs.width;
      inputsOf.height = inputs.height;
    }
    if (inputs.durationSeconds != null) {
      for (const key of ["duration", "duration_seconds", "length", "seconds", "video_length"]) {
        if (Object.prototype.hasOwnProperty.call(inputsOf, key)) inputsOf[key] = inputs.durationSeconds;
      }
    }
    if (imageIds.length && /loadimage/i.test(kind) && Object.prototype.hasOwnProperty.call(inputsOf, "image")) {
      const id = imageIds[Math.min(imageCursor, imageIds.length - 1)];
      imageCursor += 1;
      inputsOf.image = assetRef(id);
    }
  }
  return graph;
}

export function parseCredits(body) {
  const summary = body?.summary || {};
  const balance = summary.balance || null;
  const spendMicros = summary.spend_micros;
  const spendUsd = typeof spendMicros === "number" ? spendMicros / 1_000_000 : null;
  const availableUsd = typeof balance?.amount_micros === "number" ? balance.amount_micros / 100 : null;
  const prepaidUsd = typeof balance?.prepaid_balance_micros === "number" ? balance.prepaid_balance_micros / 100 : null;
  const subscriptionUsd = typeof balance?.cloud_credit_balance_micros === "number" ? balance.cloud_credit_balance_micros / 100 : null;
  return {
    raw: {
      spend_micros: spendMicros ?? null,
      amount_micros: balance?.amount_micros ?? null,
      prepaid_balance_micros: balance?.prepaid_balance_micros ?? null,
      cloud_credit_balance_micros: balance?.cloud_credit_balance_micros ?? null,
      currency: balance?.currency ?? null,
    },
    labeled: {
      spend: { value: spendUsd, unit: "USD", from: "spend_micros / 1000000" },
      available: { value: availableUsd, unit: "USD", from: "amount_micros is cents, despite the _micros name; divide by 100" },
      prepaid: { value: prepaidUsd, unit: "USD", from: "prepaid_balance_micros is cents; divide by 100" },
      subscription: { value: subscriptionUsd, unit: "USD", from: "cloud_credit_balance_micros is cents; divide by 100" },
    },
    spendUsd,
    balance: balance ? {
      availableUsd,
      prepaidUsd,
      subscriptionUsd,
      currency: balance.currency || "USD",
      note: "Raw API fields are under raw. spend_micros is millionths of a dollar. Balance *_micros fields are cents.",
    } : null,
  };
}

export const Z_IMAGE_TURBO_NAME = "z-image-turbo";

// Text-to-image used when GET /api/workflow_templates is empty.
// Files on Comfy Cloud: diffusion z_image_turbo_bf16.safetensors,
// text encoder qwen_3_4b.safetensors (CLIP type lumina2), VAE ae.safetensors.
// 8 steps, CFG 1, AuraFlow shift 3, sampler res_multistep / simple.
export function zImageTurboWorkflow() {
  return {
    "1": {
      class_type: "UNETLoader",
      inputs: { unet_name: "z_image_turbo_bf16.safetensors", weight_dtype: "default" },
      _meta: { title: "Load Z-Image Turbo" },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: { clip_name: "qwen_3_4b.safetensors", type: "lumina2", device: "default" },
      _meta: { title: "Load Qwen 3 4B" },
    },
    "3": {
      class_type: "VAELoader",
      inputs: { vae_name: "ae.safetensors" },
      _meta: { title: "Load VAE ae" },
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: { text: "", clip: ["2", 0] },
      _meta: { title: "Positive" },
    },
    "5": {
      class_type: "ConditioningZeroOut",
      inputs: { conditioning: ["4", 0] },
      _meta: { title: "Negative" },
    },
    "6": {
      class_type: "EmptySD3LatentImage",
      inputs: { width: 1024, height: 1024, batch_size: 1 },
    },
    "7": {
      class_type: "ModelSamplingAuraFlow",
      inputs: { shift: 3, model: ["1", 0] },
    },
    "8": {
      class_type: "KSampler",
      inputs: {
        seed: 0,
        steps: 8,
        cfg: 1,
        sampler_name: "res_multistep",
        scheduler: "simple",
        denoise: 1,
        model: ["7", 0],
        positive: ["4", 0],
        negative: ["5", 0],
        latent_image: ["6", 0],
      },
    },
    "9": {
      class_type: "VAEDecode",
      inputs: { samples: ["8", 0], vae: ["3", 0] },
    },
    "10": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "z-image-turbo", images: ["9", 0] },
    },
  };
}

export function builtinTemplates() {
  return [{
    name: Z_IMAGE_TURBO_NAME,
    description: "Built-in text-to-image. Z-Image Turbo bf16, Qwen 3 4B encoder, VAE ae, 8 steps. Used when Comfy Cloud returns no templates, and whenever template is omitted.",
    mediaType: "image",
    source: "built-in",
    filename: null,
    category: "built-in",
    workflow: zImageTurboWorkflow(),
  }];
}

export function withBuiltinTemplates(remote) {
  const list = Array.isArray(remote) ? remote.slice() : [];
  if (!list.some((item) => item.name === Z_IMAGE_TURBO_NAME)) {
    list.push(...builtinTemplates());
  }
  return list;
}

export function forceHttpsCloud(raw) {
  const url = new URL(raw);
  if (url.hostname === "cloud.comfy.org") url.protocol = "https:";
  return url.toString();
}

// Prefer the URL the official MCP returned (often /api/s/<id>). Use the
// /api/v2/assets/{id}/content route only when no URL was given.
export function officialDownloadUrl(output, base = CLOUD_BASE) {
  const root = new URL(forceHttpsCloud(base.endsWith("/") ? base : `${base}/`)).origin;
  if (output?.url) {
    const absolute = /^https?:\/\//i.test(output.url) ? output.url : new URL(output.url, `${root}/`).toString();
    return forceHttpsCloud(absolute);
  }
  if (output?.id) return `${root}/api/v2/assets/${encodeURIComponent(output.id)}/content`;
  throw new Error("output has no url or asset id");
}

export function contentUrlFor(output, base = CLOUD_BASE) {
  const origin = forceHttpsCloud(base.endsWith("/") ? base : `${base}/`);
  const root = new URL(origin).origin;
  if (output?.id) return `${root}/api/v2/assets/${encodeURIComponent(output.id)}/content`;
  if (!output?.url) throw new Error("output has no asset id and no url");
  const absolute = /^https?:\/\//i.test(output.url) ? output.url : new URL(output.url, `${root}/`).toString();
  return forceHttpsCloud(absolute);
}

function sameHost(left, right) {
  return new URL(left).hostname === new URL(right).hostname;
}

export async function fetchKeepingAuth(fetchImpl, url, headers, { maxRedirects = 5 } = {}) {
  let current = url;
  let authHeaders = { ...headers };
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await fetchImpl(current, { headers: authHeaders, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error(`redirect from ${current} had no Location header`);
    const next = new URL(location, current).toString();
    authHeaders = sameHost(current, next) ? authHeaders : {};
    current = next;
  }
  throw new Error(`too many redirects fetching ${url}`);
}

export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  let stop = false;
  const workers = Array.from({ length: Math.max(1, Math.min(limit || 1, items.length || 1)) }, async () => {
    while (!stop) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await fn(items[index], index) };
      } catch (err) {
        stop = true;
        results[index] = { ok: false, error: err.message || String(err) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const table = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
  };
  return table[ext] || "application/octet-stream";
}

function jobIdOf(body) {
  return body?.id || body?.job_id || body?.prompt_id || body?.job?.id || null;
}

export class ComfyCloudClient {
  constructor({ fetchImpl, key, base, env } = {}) {
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.key = key || requireApiKey(env);
    this.base = String(base || CLOUD_BASE).replace(/\/$/, "");
  }

  async request(pathname, { method = "GET", headers, body, form } = {}) {
    const requestHeaders = {
      Authorization: `Bearer ${this.key}`,
      "X-API-Key": this.key,
      ...headers,
    };
    if (body !== undefined && !form) requestHeaders["Content-Type"] = "application/json";
    let response;
    try {
      response = await this.fetchImpl(`${this.base}${pathname}`, {
        method,
        headers: requestHeaders,
        body: form || (body !== undefined ? JSON.stringify(body) : undefined),
      });
    } catch (err) {
      throw new Error(`Comfy Cloud ${method} ${pathname} failed: ${redact(err.message, this.key)}`);
    }
    const text = await response.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    if (!response.ok) {
      const message = json?.error?.message || json?.message || text || response.statusText;
      const err = new Error(redact(`Comfy Cloud ${method} ${pathname} failed (${response.status}): ${message}`, this.key));
      err.status = response.status;
      err.code = json?.error?.code || (response.status === 402 ? "insufficient_credits" : undefined);
      throw err;
    }
    return json ?? text;
  }

  async listTemplates({ query, limit = 40 } = {}) {
    const data = await this.request("/api/workflow_templates");
    let templates = withBuiltinTemplates(normalizeTemplates(data));
    if (query) {
      const needle = query.toLowerCase();
      templates = templates.filter((item) =>
        `${item.name} ${item.description} ${item.mediaType || ""} ${item.category || ""}`.toLowerCase().includes(needle));
    }
    return { templates: templates.slice(0, limit), total: templates.length };
  }

  async listModels({ folder, query, limit = 50 } = {}) {
    if (!folder) {
      const data = await this.request("/api/models");
      const models = normalizeModels(data);
      if (models.length && models.every((item) => item.name && !item.path)) {
        return { folders: models.map((item) => item.name), models: [] };
      }
      return { folders: [], models: models.slice(0, limit) };
    }
    let data;
    try {
      data = await this.request(`/api/models/${encodeURIComponent(folder)}`);
    } catch (err) {
      if (err.status !== 404) throw err;
      data = await this.request(`/api/experiment/models/${encodeURIComponent(folder)}`);
    }
    let models = normalizeModels(data);
    if (query) {
      const needle = query.toLowerCase();
      models = models.filter((item) => item.name.toLowerCase().includes(needle));
    }
    return { folder, models: models.slice(0, limit) };
  }

  async credits() {
    const end = new Date();
    const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
    const qs = new URLSearchParams({
      start: start.toISOString(),
      end: end.toISOString(),
      group_by: "product",
    });
    const body = await this.request(`/api/billing/usage/timeseries?${qs}`);
    return parseCredits(body);
  }

  async uploadFile(filePath) {
    const bytes = fs.readFileSync(filePath);
    const type = mimeFor(filePath);
    const form = new FormData();
    form.set("content_type", type);
    form.set("file", new Blob([bytes], { type }), path.basename(filePath));
    const asset = await this.request("/api/v2/assets", { method: "POST", form });
    if (!asset?.id) throw new Error(`upload of ${path.basename(filePath)} did not return an asset id`);
    return { id: asset.id, contentType: asset.content_type || type, name: path.basename(filePath) };
  }

  async submitWorkflow(workflow) {
    const body = await this.request("/api/v2/jobs", { method: "POST", body: { workflow } });
    const id = jobIdOf(body);
    if (!id) throw new Error("Comfy Cloud accepted the job but returned no id");
    return { id, status: body.status || "queued", raw: body };
  }

  async getJob(id) {
    return this.request(`/api/v2/jobs/${encodeURIComponent(id)}`);
  }

  async waitForJob(id, { timeoutMs = 600_000, intervalMs = 1500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started <= timeoutMs) {
      last = await this.getJob(id);
      const status = String(last.status || "");
      if (["succeeded", "failed", "canceled", "cancelled", "expired"].includes(status)) return last;
      await sleep(intervalMs);
    }
    const err = new Error(`job ${id} was still ${last?.status || "unknown"} after ${timeoutMs}ms`);
    err.code = "TIMEOUT";
    err.job = last;
    throw err;
  }

  async downloadOutputs(job, destDir, label = "output") {
    fs.mkdirSync(destDir, { recursive: true });
    const outputs = Array.isArray(job?.outputs) ? job.outputs : [];
    const files = [];
    for (let i = 0; i < outputs.length; i++) {
      const output = outputs[i];
      const url = contentUrlFor(output, this.base);
      files.push(await this.downloadUrl(url, destDir, output, label, i));
    }
    return files;
  }

  async downloadUrl(url, destDir, output, label, index) {
    return downloadOutputFile({
      fetchImpl: this.fetchImpl,
      key: this.key,
      url,
      destDir,
      output,
      label,
      index,
    });
  }
}

export async function downloadOutputFile({ fetchImpl, key, url, destDir, output, label, index }) {
  const response = await fetchKeepingAuth(fetchImpl, url, {
    Authorization: `Bearer ${key}`,
    "X-API-Key": key,
  });
  if (!response.ok) {
    throw new Error(`download failed (${response.status}) for ${output?.name || output?.id || url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const baseName = String(output?.name || `${index + 1}`).replace(/[^A-Za-z0-9._-]/g, "_");
  const name = `${label}-${baseName}`;
  const dest = path.join(destDir, name);
  fs.writeFileSync(dest, bytes);
  return {
    path: dest,
    name,
    type: output?.type || null,
    assetId: output?.id || null,
    bytes: bytes.length,
  };
}

export function summarizeJob(job) {
  return {
    id: job?.id || null,
    status: job?.status || null,
    progress: job?.progress || null,
    queuePosition: job?.queue_position ?? null,
    error: job?.error || null,
    outputs: (job?.outputs || []).map((output) => ({
      id: output.id,
      name: output.name,
      type: output.type,
      url: output.url,
      nodeId: output.node_id,
    })),
  };
}
