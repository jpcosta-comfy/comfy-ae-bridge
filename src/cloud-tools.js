import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ComfyCloudClient, Z_IMAGE_TURBO_NAME, applyInputs, mapPool, summarizeJob, zImageTurboWorkflow } from "./cloud.js";
import { CloudMcpClient, chooseGenBackend, registerAeGenerateViaMcp, registerOfficialTools, withPaidQueue } from "./comfy-mcp.js";
import { placeVariantsJsx } from "./jsxlib.js";

const SELF =
  "comfy-ae-bridge generates on Comfy Cloud by itself with COMFY_CLOUD_API_KEY. " +
  "Do not call a separate Comfy Cloud, comfy-mcp, or comfy-cloud connector. ";

function asToolResult(res) {
  return {
    content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
    isError: !res.ok,
  };
}

function clientOrError(factory) {
  try {
    return { client: factory() };
  } catch (err) {
    return { error: asToolResult({ ok: false, error: err.message, code: err.code || "MISSING_KEY" }) };
  }
}

async function resolveWorkflow(client, { template, workflow }) {
  if (workflow) return applyInputs(workflow, {});
  if (!template || template === Z_IMAGE_TURBO_NAME) return zImageTurboWorkflow();
  const listed = await client.listTemplates({ query: template, limit: 50 });
  const match = listed.templates.find((item) => item.name === template)
    || listed.templates.find((item) => item.name.toLowerCase() === template.toLowerCase());
  if (!match) {
    throw new Error(`No Comfy Cloud template matched "${template}". Omit template to use built-in ${Z_IMAGE_TURBO_NAME}, or call comfy_list_templates.`);
  }
  if (match.source === "built-in") return zImageTurboWorkflow();
  if (match.workflow && typeof match.workflow === "object") return match.workflow;
  throw new Error(
    `Template "${match.name}" is listed but Comfy Cloud did not include its API workflow. ` +
    `Omit template to use built-in ${Z_IMAGE_TURBO_NAME}, or pass workflow as API-format JSON.`,
  );
}

function outputDirFromEnv() {
  return process.env.COMFY_AE_OUTPUT_DIR || path.join(os.tmpdir(), "comfy-ae-bridge-outputs");
}

export function registerCloudTools(server, bridge, options = {}) {
  const factory = options.clientFactory || (() => new ComfyCloudClient());

  server.registerTool(
    "comfy_list_templates",
    {
      title: "List Comfy Cloud workflow templates",
      description: SELF + "GET /api/workflow_templates on cloud.comfy.org. If Cloud returns nothing, the list still includes built-in z-image-turbo (Z-Image Turbo bf16, Qwen 3 4B, VAE ae, 8 steps). Use a returned name as comfy_generate.template. No other Comfy connector is required.",
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive filter on name, description, and media type"),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ query, limit }) => {
      const ready = clientOrError(factory);
      if (ready.error) return ready.error;
      try {
        const result = await ready.client.listTemplates({ query, limit });
        return asToolResult({ ok: true, ...result });
      } catch (err) {
        return asToolResult({ ok: false, error: err.message });
      }
    },
  );

  server.registerTool(
    "comfy_list_models",
    {
      title: "List Comfy Cloud models",
      description: SELF + "GET /api/models and /api/models/{folder} on cloud.comfy.org. Omit folder to list folders. No other Comfy connector is required.",
      inputSchema: {
        folder: z.string().optional().describe("Model folder such as checkpoints, loras, vae, diffusion_models"),
        query: z.string().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ folder, query, limit }) => {
      const ready = clientOrError(factory);
      if (ready.error) return ready.error;
      try {
        return asToolResult({ ok: true, ...(await ready.client.listModels({ folder, query, limit })) });
      } catch (err) {
        return asToolResult({ ok: false, error: err.message });
      }
    },
  );

  server.registerTool(
    "comfy_generate",
    {
      title: "Generate image or video on Comfy Cloud",
      description:
        SELF + "Uploads local images (POST /api/v2/assets), submits an API-format workflow (POST /api/v2/jobs), " +
        "polls GET /api/v2/jobs/{id}, and downloads outputs over https://cloud.comfy.org/api/v2/assets/{id}/content. " +
        "Omit template and workflow to run built-in z-image-turbo text-to-image. " +
        "prompt, seed, width, height, and duration_seconds patch matching node inputs. " +
        "variants run with concurrency (default 1) because parallel paid calls fail more often. " +
        "Includes credit balance when GET /api/billing/usage/timeseries returns it.",
      inputSchema: {
        template: z.string().optional().describe("Template name from comfy_list_templates"),
        workflow: z.record(z.any()).optional().describe("API-format workflow. Not the UI nodes/links export."),
        prompt: z.string().optional(),
        seed: z.number().int().optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        duration_seconds: z.number().positive().optional(),
        images: z.array(z.string()).optional().describe("Local file paths uploaded as core/ASSET inputs"),
        variants: z.number().int().positive().max(8).optional().describe("How many jobs. Default 1."),
        concurrency: z.number().int().positive().max(4).optional().describe("Parallel jobs. Default 1."),
        wait: z.boolean().optional().describe("Poll until the job finishes. Default true."),
        output_dir: z.string().optional().describe("Download folder. Default COMFY_AE_OUTPUT_DIR or a temp folder."),
        timeout_ms: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      const ready = clientOrError(factory);
      if (ready.error) return ready.error;
      try {
        const result = await runGeneration(ready.client, args, args.output_dir || outputDirFromEnv());
        return asToolResult({ ok: result.jobs.every((job) => job.ok !== false && job.status !== "failed"), ...result });
      } catch (err) {
        return asToolResult({ ok: false, error: err.message, code: err.code });
      }
    },
  );

  server.registerTool(
    "comfy_job_status",
    {
      title: "Comfy Cloud job status",
      description: SELF + "GET /api/v2/jobs/{id}. Returns status, progress, and outputs. Set wait true to poll until the job finishes.",
      inputSchema: {
        job_id: z.string(),
        wait: z.boolean().optional(),
        timeout_ms: z.number().int().positive().optional(),
      },
    },
    async ({ job_id, wait, timeout_ms }) => {
      const ready = clientOrError(factory);
      if (ready.error) return ready.error;
      try {
        const job = wait
          ? await ready.client.waitForJob(job_id, { timeoutMs: timeout_ms })
          : await ready.client.getJob(job_id);
        return asToolResult({ ok: true, job: summarizeJob(job) });
      } catch (err) {
        return asToolResult({ ok: false, error: err.message, job: err.job ? summarizeJob(err.job) : undefined });
      }
    },
  );

  server.registerTool(
    "comfy_download",
    {
      title: "Download Comfy Cloud job outputs",
      description: SELF + "Downloads each output of a finished job to a local folder. Authenticated GET of the asset content URL.",
      inputSchema: {
        job_id: z.string(),
        output_dir: z.string().optional(),
      },
    },
    async ({ job_id, output_dir }) => {
      const ready = clientOrError(factory);
      if (ready.error) return ready.error;
      try {
        const job = await ready.client.getJob(job_id);
        const dir = output_dir || outputDirFromEnv();
        const files = await ready.client.downloadOutputs(job, dir, "output");
        return asToolResult({ ok: true, job: summarizeJob(job), files, outputDir: dir });
      } catch (err) {
        return asToolResult({ ok: false, error: err.message });
      }
    },
  );

  server.registerTool(
    "ae_generate_and_place",
    {
      title: "Generate on Comfy Cloud and place in After Effects",
      description:
        SELF + "One shot: generate variants on Comfy Cloud, download them beside the open .aep " +
        "(or COMFY_AE_OUTPUT_DIR), then import them. With template_comp and placeholder_layer, " +
        "duplicates the comp per variant and queues 16:9, 9:16, and 1:1. With layer, swaps that layer's source. " +
        "concurrency defaults to 1. No separate Comfy connector is used.",
      inputSchema: {
        template: z.string().optional(),
        workflow: z.record(z.any()).optional(),
        prompt: z.string().optional(),
        seed: z.number().int().optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        duration_seconds: z.number().positive().optional(),
        images: z.array(z.string()).optional(),
        variants: z.number().int().positive().max(8).optional(),
        concurrency: z.number().int().positive().max(4).optional(),
        template_comp: z.string().optional().describe("AE comp to duplicate per variant"),
        placeholder_layer: z.string().optional().describe("Layer whose source is replaced inside the template"),
        layer: z.string().optional().describe("Swap this layer to the first output when there is no template comp"),
        aspects: z.array(z.enum(["16:9", "9:16", "1:1", "4:5"])).optional(),
        output_dir: z.string().optional(),
        timeout_ms: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      const ready = clientOrError(factory);
      if (ready.error) return ready.error;
      try {
        const located = await bridge.exec(
          "(app.project && app.project.file) ? app.project.file.parent.fsName : \"\"",
        );
        const beside = located?.ok && located.result ? path.join(String(located.result), "comfy-generations") : null;
        const dir = args.output_dir || process.env.COMFY_AE_OUTPUT_DIR || beside || outputDirFromEnv();
        fs.mkdirSync(dir, { recursive: true });
        const generated = await runGeneration(ready.client, { ...args, wait: true }, dir);
        const files = generated.jobs.flatMap((job) => job.files || []);
        if (!files.length) {
          return asToolResult({ ok: false, error: "Comfy Cloud returned no files to place.", ...generated });
        }
        let placed = null;
        if (args.template_comp && args.placeholder_layer) {
          const jsx = placeVariantsJsx({
            template_comp: args.template_comp,
            placeholder_layer: args.placeholder_layer,
            assets: files.map((file, index) => ({ path: file.path, label: `v${index + 1}` })),
            aspects: args.aspects,
            output_dir: dir,
          });
          placed = await bridge.exec(jsx, args.timeout_ms || 120_000);
        } else if (args.layer) {
          const { jsxWithArgs } = await import("./jsxlib.js");
          const jsx = jsxWithArgs({ path: files[0].path, layer: args.layer }, `
  var c = app.project.activeItem;
  if (!(c && c instanceof CompItem)) throw new Error("no active comp");
  var target = null;
  for (var i = 1; i <= c.numLayers; i++) if (c.layer(i).name === ARGS.layer) { target = c.layer(i); break; }
  if (!target) throw new Error("layer not found: " + ARGS.layer);
  var f = new File(ARGS.path);
  if (!f.exists) throw new Error("file not found: " + ARGS.path);
  var item = app.project.importFile(new ImportOptions(f));
  target.replaceSource(item, false);
  return { comp: c.name, layer: target.name, file: f.fsName };`);
          placed = await bridge.exec(jsx, args.timeout_ms || 60_000);
        } else {
          const imported = [];
          for (const file of files) {
            const one = await bridge.exec(
              `var f = new File(${JSON.stringify(file.path)}); if (!f.exists) throw new Error("missing " + f.fsName); var item = app.project.importFile(new ImportOptions(f)); ({ id: item.id, name: item.name, file: f.fsName });`,
              args.timeout_ms || 60_000,
            );
            imported.push(one);
          }
          placed = { imports: imported };
        }
        const placeOk = placed?.ok !== false && !placed?.imports?.some((item) => item && item.ok === false);
        return asToolResult({
          ok: placeOk && generated.jobs.every((job) => job.ok !== false),
          outputDir: dir,
          ...generated,
          placed,
        });
      } catch (err) {
        return asToolResult({ ok: false, error: err.message, code: err.code });
      }
    },
  );
}

async function runGeneration(client, args, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const baseWorkflow = await resolveWorkflow(client, args);
  const imageAssetIds = [];
  for (const imagePath of args.images || []) {
    const uploaded = await client.uploadFile(imagePath);
    imageAssetIds.push(uploaded.id);
  }
  let credits = null;
  try { credits = await client.credits(); } catch { credits = null; }
  const count = args.variants || 1;
  const seedBase = args.seed != null ? args.seed : (count > 1 ? Math.floor(Math.random() * 1_000_000_000) : null);
  const jobs = await mapPool(
    Array.from({ length: count }, (_, index) => index),
    args.concurrency || 1,
    async (_item, index) => {
      const workflow = applyInputs(baseWorkflow, {
        prompt: args.prompt,
        seed: seedBase == null ? null : seedBase + index,
        width: args.width,
        height: args.height,
        durationSeconds: args.duration_seconds,
        imageAssetIds,
      });
      const submitted = await client.submitWorkflow(workflow);
      if (args.wait === false) return { ok: true, id: submitted.id, status: submitted.status, files: [] };
      const job = await client.waitForJob(submitted.id, { timeoutMs: args.timeout_ms });
      if (job.status !== "succeeded") {
        const err = new Error(job.error?.message || `job ${submitted.id} ${job.status}`);
        err.job = job;
        throw err;
      }
      const files = await client.downloadOutputs(job, destDir, `v${index + 1}`);
      return { ok: true, ...summarizeJob(job), files };
    },
  );
  return {
    credits,
    outputDir: destDir,
    jobs: jobs.map((item) => item ? (item.ok ? item.value : { ok: false, error: item.error }) : { ok: false, error: "not started" }),
  };
}

export async function registerGeneration(server, bridge, options = {}) {
  const mode = String(options.backend || process.env.COMFY_GEN_BACKEND || "auto").toLowerCase();
  if (options.clientFactory && !options.mcpSession && mode !== "mcp") {
    registerCloudTools(server, bridge, options);
    return { backend: "rest" };
  }
  if (mode === "rest") {
    registerCloudTools(server, bridge, options);
    return { backend: "rest" };
  }
  try {
    const session = options.mcpSession || new CloudMcpClient({
      apiKey: process.env.COMFY_CLOUD_API_KEY,
      url: process.env.COMFY_CLOUD_MCP_URL,
    });
    if (!options.mcpSession) {
      await Promise.race([
        session.connect(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Comfy Cloud MCP timed out")), 8000)),
      ]);
    } else if (!session.tools?.length && session.connect) {
      await session.connect();
    }
    if (!session.tools?.length) throw new Error("official Comfy Cloud MCP returned no tools");
    const queued = withPaidQueue(session);
    registerOfficialTools(server, queued);
    registerAeGenerateViaMcp(server, bridge, queued);
    console.error("[comfy-ae-bridge] generation backend mcp (official https://cloud.comfy.org/mcp)");
    return { backend: "mcp" };
  } catch (err) {
    const decided = chooseGenBackend(mode, false);
    if (decided === "mcp") {
      server.registerTool("comfy_cloud", {
        title: "Comfy Cloud MCP unavailable",
        description: "The official Comfy Cloud MCP could not be reached. Do not add a second connector. Fix COMFY_CLOUD_API_KEY or set COMFY_GEN_BACKEND=rest.",
        inputSchema: {},
      }, async () => ({
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: err.message, backend: "mcp" }) }],
        isError: true,
      }));
      return { backend: "mcp", error: err.message };
    }
    registerCloudTools(server, bridge, options);
    console.error(`[comfy-ae-bridge] generation backend rest (${err.message})`);
    return { backend: "rest", fallback: err.message };
  }
}
