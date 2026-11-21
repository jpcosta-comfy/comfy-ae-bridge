import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chooseGenBackend, PAID_TOOL_NAMES } from "../src/comfy-mcp.js";
import { buildMcpServer } from "../src/server.js";

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log("PASS", name);
  } catch (err) {
    failed += 1;
    console.log("FAIL", name, err?.stack || err);
  }
}

await check("auto uses mcp only when the official server is reachable", async () => {
  assert.equal(chooseGenBackend("auto", true), "mcp");
  assert.equal(chooseGenBackend("auto", false), "rest");
  assert.equal(chooseGenBackend("mcp", false), "mcp");
  assert.equal(chooseGenBackend("rest", true), "rest");
  assert.equal(PAID_TOOL_NAMES.has("run_template"), true);
  assert.equal(PAID_TOOL_NAMES.has("search_templates"), false);
});

function fakeOfficial() {
  let inFlight = 0;
  let maxInFlight = 0;
  const calls = [];
  const downloads = [];
  const tools = [
    { name: "search_templates", description: "Search pre-built templates", inputSchema: { type: "object", properties: { query: { type: "string", description: "text" } } } },
    { name: "run_template", description: "Run a template. Set confirm to true before a paid run.", inputSchema: { type: "object", properties: { name: { type: "string" }, params: { type: "object" }, confirm: { type: "boolean", description: "Set `true` only to answer that prompt with the user's explicit yes. A standing spending rule counts." } }, required: ["name", "confirm"] } },
    { name: "wait_for_job", description: "Wait until a job finishes", inputSchema: { type: "object", properties: { prompt_id: { type: "string" } } } },
    { name: "wait_for_output", description: "Wait and return the output shortlink", inputSchema: { type: "object", properties: { prompt_id: { type: "string" }, client_os: { type: "string" } } } },
    { name: "get_output", description: "Retrieve outputs", inputSchema: { type: "object", properties: { prompt_id: { type: "string" } } } },
    { name: "partner_generate", description: "Partner model generation", inputSchema: { type: "object", properties: { model: { type: "string" } } } },
  ];
  return {
    apiKey: "test-key",
    tools,
    calls,
    downloads,
    maxInFlight: () => maxInFlight,
    hasTool: (name) => tools.some((tool) => tool.name === name),
    fetchImpl: async (url, init = {}) => {
      downloads.push({ url: String(url), auth: init.headers?.Authorization || "", redirect: init.redirect });
      return new Response(Buffer.from("png-bytes"));
    },
    async callTool(name, args) {
      if (name === "run_template" || name === "partner_generate") {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 40));
        inFlight -= 1;
      }
      calls.push({ name, args });
      if (name === "search_templates") {
        return { content: [{ type: "text", text: JSON.stringify({ templates: [{ name: "image_z_image_turbo", title: "Z-Image Turbo" }] }) }] };
      }
      if (name === "run_template" || name === "partner_generate") {
        return { content: [{ type: "text", text: JSON.stringify({ prompt_id: `job-${calls.length}` }) }] };
      }
      if (name === "wait_for_job") {
        return { content: [{ type: "text", text: JSON.stringify({ status: "succeeded", prompt_id: args.prompt_id }) }] };
      }
      if (name === "wait_for_output" || name === "get_output") {
        return { content: [{ type: "text", text: JSON.stringify({ outputs: [{ id: "asset-9", name: "frame.png", type: "image", url: "http://cloud.comfy.org/api/s/abc123" }] }) }] };
      }
      return { content: [{ type: "text", text: "{}" }] };
    },
  };
}

async function withServer(session, bridge) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await buildMcpServer(bridge, { mcpSession: session, backend: "mcp" });
  await server.connect(serverTransport);
  const client = new Client({ name: "proxy-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

await check("official tools are proxied under comfy_ and paid calls stay serial", async () => {
  const session = fakeOfficial();
  const bridge = { exec: async () => ({ ok: true, result: "" }), snapshot: () => ({ connected: true }) };
  const { client, close } = await withServer(session, bridge);
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.includes("comfy_search_templates"));
    assert.ok(names.includes("comfy_run_template"));
    assert.ok(names.includes("comfy_partner_generate"));
    assert.ok(names.includes("ae_generate_and_place"));
    assert.equal(names.includes("comfy_list_templates"), false);
    const run = listed.tools.find((tool) => tool.name === "comfy_run_template");
    assert.match(run.description, /Do not add a separate/);
    assert.match(run.description, /one at a time/);
    assert.match(run.description, /confirmation dialog to the user/);
    assert.doesNotMatch(run.description, /Set confirm to true/);
    assert.equal(run.inputSchema.properties.confirm.description, "A paid run shows a confirmation dialog to the user.");
    assert.ok(!run.inputSchema.required?.includes("confirm"));
    await Promise.all([
      client.callTool({ name: "comfy_run_template", arguments: { name: "image_z_image_turbo", params: { prompt: "a" } } }),
      client.callTool({ name: "comfy_partner_generate", arguments: { model: "flux" } }),
    ]);
    assert.equal(session.maxInFlight(), 1);
  } finally {
    await close();
  }
});

await check("ae_generate_and_place uses official tools then the https asset download", async () => {
  const session = fakeOfficial();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cab-mcp-place-"));
  const project = path.join(dir, "project");
  fs.mkdirSync(project);
  const placed = [];
  const bridge = {
    snapshot: () => ({ connected: true }),
    exec: async (jsx) => {
      const text = String(jsx);
      if (text.includes("numItems") && !text.includes("ae_place_variants") && !text.includes("CompItem")) {
        const info = { open: true, saved: true, path: path.join(project, "Launch.aep"), name: "Launch.aep", numItems: 4, activeComp: null };
        return { ok: true, result: info, projectInfo: info, project: info.path };
      }
      if (text.includes("CompItem") && !text.includes("ae_place_variants")) {
        return { ok: true, result: { name: "Launch_Master", width: 1920, height: 1080 }, project: path.join(project, "Launch.aep") };
      }
      placed.push(text);
      return { ok: true, result: { queued: [{ output: "out.mp4" }] }, project: path.join(project, "Launch.aep") };
    },
  };
  const { client, close } = await withServer(session, bridge);
  try {
    const raw = await client.callTool({
      name: "ae_generate_and_place",
      arguments: {
        prompt: "a red square",
        template_comp: "Launch_Master",
        placeholder_layer: "MEDIA",
        variants: 2,
        output_dir: dir,
      },
    });
    const body = JSON.parse(raw.content[0].text);
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.backend, "mcp");
    const runs = session.calls.filter((call) => call.name === "run_template");
    assert.equal(runs.length, 2);
    assert.equal(runs[0].args.name, "image_z_image_turbo");
    assert.equal(runs[0].args.client_os, process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux");
    assert.equal(runs[0].args.params.width, 1920);
    assert.equal(runs[0].args.params.height, 1088);
    assert.equal(session.maxInFlight(), 1);
    assert.ok(session.calls.some((call) => call.name === "wait_for_output"));
    assert.equal(session.downloads[0].url, "https://cloud.comfy.org/api/s/abc123");
    assert.match(session.downloads[0].auth, /test-key/);
    assert.equal(session.downloads[0].redirect, "manual");
    assert.equal(placed.length, 1);
    assert.match(placed[0], /v1-frame\.png/);
    assert.match(placed[0], /v2-frame\.png/);
  } finally {
    await close();
  }
});

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nmcp proxy ok");
