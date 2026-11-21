// MCP client for the official Comfy Cloud server at https://cloud.comfy.org/mcp.
// Auth for this headless process is the X-API-Key header (COMFY_CLOUD_API_KEY).
// OAuth is what interactive clients use; this process has no browser.
// Official run tools are serialized: parallel paid calls come back cancelled.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { clientOs, normalizeClientOsArgs, roundUpToMultiple } from "./client-os.js";
import { downloadOutputFile, officialDownloadUrl, redact } from "./cloud.js";
import { placeVariantsJsx } from "./jsxlib.js";

export const CLOUD_MCP_URL = "https://cloud.comfy.org/mcp";

export const PAID_TOOL_NAMES = new Set([
  "run_template",
  "submit_workflow",
  "partner_generate",
  "run_saved_workflow",
  "submit_batch",
  "generate-image",
  "generate-video",
  "generate-audio",
  "generate-3d",
  "upscale-image",
  "remove-background",
]);

const SELF =
  "Proxied from the official Comfy Cloud MCP (https://cloud.comfy.org/mcp) through comfy-ae-bridge. " +
  "Do not add a separate Comfy Cloud or comfy-cloud connector. ";

export function chooseGenBackend(mode, mcpReady) {
  const picked = String(mode || "auto").toLowerCase();
  if (picked === "rest") return "rest";
  if (picked === "mcp") return "mcp";
  return mcpReady ? "mcp" : "rest";
}

export function prefixToolName(name) {
  return `comfy_${String(name).replace(/-/g, "_")}`;
}

export function proxyInputSchema(remote) {
  const props = remote?.properties || {};
  const shape = {};
  for (const [key, spec] of Object.entries(props)) {
    let field = z.any();
    if (spec?.description) field = field.describe(String(spec.description));
    if (!remote?.required?.includes(key)) field = field.optional();
    shape[key] = field;
  }
  return z.object(shape).passthrough();
}

export function toolText(result) {
  return (result?.content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

export function parseToolJson(result) {
  const text = toolText(result);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export function jobIdFromToolResult(result) {
  const json = parseToolJson(result);
  const id = json?.prompt_id || json?.job_id || json?.id || json?.job?.id;
  if (id) return String(id);
  const match = toolText(result).match(/prompt_id["'\s:=]+([0-9a-f-]{8,})/i);
  return match ? match[1] : null;
}

export function outputsFromToolResult(result) {
  const found = [];
  const json = parseToolJson(result);
  if (json) collectOutputs(json, found);
  if (!found.length) {
    for (const url of toolText(result).match(/https?:\/\/[^\s"'<>]+/g) || []) found.push({ url });
  }
  const seen = new Set();
  return found.filter((item) => {
    const key = item.id || item.url;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectOutputs(node, found) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) collectOutputs(item, found);
    return;
  }
  if (typeof node !== "object") return;
  if (node.url || (node.id && (node.name || node.filename || node.type))) found.push(node);
  for (const key of ["outputs", "files", "images"]) {
    if (node[key]) collectOutputs(node[key], found);
  }
}

export function templateNameFrom(result) {
  const json = parseToolJson(result);
  const list = json?.templates || json?.items || (Array.isArray(json) ? json : []);
  const first = list[0];
  return first?.name || first?.id || first?.title || null;
}

export class CloudMcpClient {
  constructor({ url = CLOUD_MCP_URL, apiKey, client, tools, fetchImpl } = {}) {
    this.url = url || CLOUD_MCP_URL;
    this.apiKey = apiKey || "";
    this.client = client || null;
    this.tools = tools || [];
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.paid = Promise.resolve();
  }

  hasTool(name) {
    return this.tools.some((tool) => tool.name === name);
  }

  async connect() {
    if (this.client) {
      if (!this.tools.length && this.client.listTools) {
        const listed = await this.client.listTools();
        this.tools = listed.tools || [];
      }
      return this.tools;
    }
    if (!this.apiKey) {
      const err = new Error("COMFY_CLOUD_API_KEY is not set. The official Comfy Cloud MCP at https://cloud.comfy.org/mcp needs it as the X-API-Key header.");
      err.code = "MISSING_KEY";
      throw err;
    }
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: { "X-API-Key": this.apiKey } },
    });
    const client = new Client({ name: "comfy-ae-bridge", version: "0.1.0" });
    await client.connect(transport);
    this.client = client;
    this.transport = transport;
    const listed = await client.listTools();
    this.tools = listed.tools || [];
    return this.tools;
  }

  async callTool(name, args) {
    const run = async () => {
      const result = await this.client.callTool({ name, arguments: args || {} });
      if (result?.isError) {
        throw new Error(redact(toolText(result) || `${name} failed`, this.apiKey));
      }
      return result;
    };
    if (!PAID_TOOL_NAMES.has(name)) return run();
    const job = this.paid.then(run, run);
    this.paid = job.then(() => {}, () => {});
    return job;
  }

  async close() {
    try { await this.client?.close?.(); } catch { /* ignore */ }
    try { await this.transport?.close?.(); } catch { /* ignore */ }
  }
}

export function withPaidQueue(session) {
  if (session._paidQueue) return session;
  let chain = Promise.resolve();
  return {
    apiKey: session.apiKey,
    fetchImpl: session.fetchImpl,
    tools: session.tools,
    _paidQueue: true,
    hasTool: (name) => session.hasTool(name),
    callTool(name, args) {
      const run = () => session.callTool(name, args);
      if (!PAID_TOOL_NAMES.has(name)) return run();
      const job = chain.then(run, run);
      chain = job.then(() => {}, () => {});
      return job;
    },
  };
}

export function registerOfficialTools(server, session) {
  for (const tool of session.tools) {
    const localName = prefixToolName(tool.name);
    const paid = PAID_TOOL_NAMES.has(tool.name);
    server.registerTool(localName, {
      title: tool.title || tool.name,
      description: SELF + (paid ? "Runs one at a time so paid Cloud calls are not cancelled. client_os must be darwin, win32, or linux; macos is sent as darwin. Confirm spend before a paid run. " : "") + (tool.description || tool.name),
      inputSchema: proxyInputSchema(tool.inputSchema),
    }, async (args) => {
      try {
        const cleaned = normalizeClientOsArgs(args || {});
        if (PAID_TOOL_NAMES.has(tool.name)) {
          const osName = clientOs(cleaned.client_os ?? cleaned.params?.client_os);
          cleaned.client_os = osName;
          if (tool.name === "run_template") {
            cleaned.params = { ...(cleaned.params || {}), client_os: osName };
          }
        }
        const result = await session.callTool(tool.name, cleaned);
        return {
          content: result.content?.length ? result.content : [{ type: "text", text: JSON.stringify(result) }],
          isError: false,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: redact(err.message, session.apiKey) }) }],
          isError: true,
        };
      }
    });
  }
}

export async function generateWithOfficial(session, args, destDir) {
  const count = args.variants || 1;
  const jobs = [];
  for (let index = 0; index < count; index++) {
    const seed = args.seed == null ? undefined : args.seed + index;
    let submitted;
    if (args.workflow) {
      submitted = await session.callTool("submit_workflow", {
        workflow: args.workflow,
        prompt: args.prompt,
        seed,
        client_os: clientOs(args.client_os),
      });
    } else {
      let name = args.template;
      if (!name && session.hasTool("search_templates")) {
        const found = await session.callTool("search_templates", { query: "z-image turbo text to image", limit: 5, type: "image" });
        name = templateNameFrom(found);
      }
      name = name || "image_z_image_turbo";
      const osName = clientOs(args.client_os);
      const params = { client_os: osName };
      if (args.prompt) params.prompt = args.prompt;
      if (seed != null) params.seed = seed;
      if (args.width) params.width = roundUpToMultiple(args.width);
      if (args.height) params.height = roundUpToMultiple(args.height);
      if (args.duration_seconds != null) params.duration = args.duration_seconds;
      submitted = await session.callTool("run_template", { name, params, client_os: osName });
    }
    const promptId = jobIdFromToolResult(submitted);
    let waited = submitted;
    const waitArgs = { prompt_id: promptId, job_id: promptId, client_os: clientOs(args.client_os) };
    if (promptId && session.hasTool("wait_for_output")) {
      waited = await session.callTool("wait_for_output", waitArgs);
    } else if (promptId && session.hasTool("wait_for_job")) {
      waited = await session.callTool("wait_for_job", waitArgs);
    }
    let outputs = outputsFromToolResult(waited);
    if (!outputs.length && promptId && session.hasTool("get_output")) {
      const got = await session.callTool("get_output", waitArgs);
      outputs = outputsFromToolResult(got);
    }
    const files = [];
    for (let i = 0; i < outputs.length; i++) {
      const output = outputs[i];
      const url = officialDownloadUrl(output);
      files.push(await downloadOutputFile({
        fetchImpl: session.fetchImpl,
        key: session.apiKey,
        url,
        destDir,
        output,
        label: `v${index + 1}`,
        index: i,
      }));
    }
    jobs.push({ ok: files.length > 0, promptId, files, outputs });
  }
  return { backend: "mcp", jobs };
}

export function registerAeGenerateViaMcp(server, bridge, session) {
  server.registerTool(
    "ae_generate_and_place",
    {
      title: "Generate with official Comfy Cloud MCP and place in After Effects",
      description:
        "Uses the official Comfy Cloud MCP on this same server (run_template or submit_workflow, then wait_for_output or wait_for_job and get_output). " +
        "Downloads the URL or /api/s/ shortlink that tool returns. client_os is darwin, win32, or linux (macOS is sent as darwin). " +
        "Generation width and height are rounded up to a multiple of 16, then the image is fit and centered in the target comp. " +
        "Runs variants one at a time. Do not add a separate Comfy Cloud connector.",
      inputSchema: {
        template: z.string().optional().describe("Official template name for run_template. Omit to search for Z-Image Turbo."),
        workflow: z.record(z.any()).optional().describe("API-format workflow passed to submit_workflow."),
        prompt: z.string().optional(),
        seed: z.number().int().optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        duration_seconds: z.number().positive().optional(),
        variants: z.number().int().positive().max(8).optional().describe("Sequential. Default 1. Parallel official runs get cancelled."),
        template_comp: z.string().optional(),
        placeholder_layer: z.string().optional(),
        layer: z.string().optional(),
        aspects: z.array(z.enum(["16:9", "9:16", "1:1", "4:5"])).optional(),
        output_dir: z.string().optional(),
        timeout_ms: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      try {
        const located = await bridge.exec(
          "(function(){var info={open:false,saved:false,path:\"\",name:\"\",numItems:0};if(!app.project)return info;info.open=true;info.numItems=app.project.numItems;if(app.project.file){info.saved=true;info.path=app.project.file.fsName;info.name=app.project.file.name;}else{info.name=\"(unsaved project)\";}return info;})();",
        );
        const info = located?.result && typeof located.result === "object" ? located.result : null;
        const beside = info?.path ? path.join(path.dirname(info.path), "comfy-generations") : null;
        const dir = args.output_dir || process.env.COMFY_AE_OUTPUT_DIR || beside || path.join(process.cwd(), "comfy-generations");
        fs.mkdirSync(dir, { recursive: true });
        let width = args.width;
        let height = args.height;
        if (args.template_comp) {
          const wanted = JSON.stringify(args.template_comp);
          const comp = await bridge.exec(
            `(function(){var c=null;for(var i=1;i<=app.project.numItems;i++){var it=app.project.item(i);if(it instanceof CompItem&&it.name===${wanted}){c=it;break;}}if(!c)return null;return {name:c.name,width:c.width,height:c.height};})();`,
          );
          if (comp?.ok && comp.result?.width) {
            width = width || comp.result.width;
            height = height || comp.result.height;
          }
        }
        if (width) width = roundUpToMultiple(width);
        if (height) height = roundUpToMultiple(height);
        const generated = await generateWithOfficial(session, { ...args, width, height }, dir);
        const files = generated.jobs.flatMap((job) => job.files || []);
        if (!files.length) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Official Comfy Cloud MCP returned no files to place.", ...generated }) }],
            isError: true,
          };
        }
        let placed;
        if (args.template_comp && args.placeholder_layer) {
          const jsx = placeVariantsJsx({
            template_comp: args.template_comp,
            placeholder_layer: args.placeholder_layer,
            assets: files.map((file, index) => ({ path: file.path, label: `v${index + 1}` })),
            aspects: args.aspects,
            output_dir: dir,
            fit: "contain",
            fit_layer: true,
          });
          placed = await bridge.exec(jsx, args.timeout_ms || 120_000);
        } else {
          placed = await bridge.exec(
            `var f = new File(${JSON.stringify(files[0].path)}); if (!f.exists) throw new Error("missing"); var item = app.project.importFile(new ImportOptions(f)); ({ id: item.id, name: item.name, file: f.fsName });`,
            args.timeout_ms || 60_000,
          );
        }
        const ok = placed?.ok !== false && generated.jobs.every((job) => job.ok);
        return {
          content: [{ type: "text", text: JSON.stringify({ ok, backend: "mcp", outputDir: dir, ...generated, placed }) }],
          isError: !ok,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: redact(err.message, session.apiKey) }) }],
          isError: true,
        };
      }
    },
  );
}
