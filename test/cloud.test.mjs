import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { applyInputs, contentUrlFor, parseCredits, requireApiKey } from "../src/cloud.js";
import { ComfyCloudClient } from "../src/cloud.js";
import { buildMcpServer } from "../src/server.js";

const workflow = {
  "6": { class_type: "CLIPTextEncode", inputs: { text: "old" }, _meta: { title: "Positive" } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "bad" }, _meta: { title: "Negative" } },
  "5": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
  "3": { class_type: "KSampler", inputs: { seed: 1, steps: 20 } },
  "8": { class_type: "LoadImage", inputs: { image: "placeholder.png" } },
  "9": { class_type: "VHS_VideoCombine", inputs: { duration: 2, frame_rate: 24 } },
};

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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

await check("missing API key is a clear error and does not echo a secret", async () => {
  assert.throws(() => requireApiKey({}), /COMFY_CLOUD_API_KEY is not set/);
  const secret = "super-secret-key";
  const client = new ComfyCloudClient({
    key: secret,
    fetchImpl: async () => json({ message: `rejected ${secret}` }, 500),
  });
  await assert.rejects(() => client.listTemplates(), (err) => {
    assert.equal(err.message.includes(secret), false);
    assert.match(err.message, /\[redacted\]/);
    return true;
  });
});

await check("applyInputs patches prompt, seed, size, duration, and asset", async () => {
  const next = applyInputs(workflow, {
    prompt: "a product hero",
    seed: 7,
    width: 1280,
    height: 720,
    durationSeconds: 4,
    imageAssetIds: ["asset-1"],
  });
  assert.equal(next["6"].inputs.text, "a product hero");
  assert.equal(next["7"].inputs.text, "bad");
  assert.equal(next["3"].inputs.seed, 7);
  assert.equal(next["5"].inputs.width, 1280);
  assert.equal(next["5"].inputs.height, 720);
  assert.equal(next["9"].inputs.duration, 4);
  assert.deepEqual(next["8"].inputs.image, { type: "core/ASSET", id: "asset-1" });
  assert.throws(() => applyInputs({ nodes: [], links: [] }, {}), /UI-format/);
});

await check("credits parse cents and spend micros", async () => {
  const credits = parseCredits({
    summary: {
      spend_micros: 2_500_000,
      balance: { amount_micros: 4250, prepaid_balance_micros: 2250, cloud_credit_balance_micros: 2000, currency: "USD" },
    },
  });
  assert.equal(credits.spendUsd, 2.5);
  assert.equal(credits.balance.availableUsd, 42.5);
  assert.equal(credits.balance.prepaidUsd, 22.5);
  assert.equal(credits.balance.subscriptionUsd, 20);
  assert.equal(credits.raw.spend_micros, 2_500_000);
  assert.equal(credits.raw.amount_micros, 4250);
  assert.equal(credits.labeled.spend.value, 2.5);
  assert.equal(credits.labeled.spend.unit, "USD");
  assert.match(credits.labeled.spend.from, /1000000/);
  assert.equal(credits.labeled.available.value, 42.5);
  assert.match(credits.labeled.available.from, /cents/);
});

function cloudFetch({ delayMs = 30 } = {}) {
  const submitted = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let jobCount = 0;
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    const method = init.method || "GET";
    if (target.endsWith("/api/workflow_templates")) {
      return json({
        Video: [{
          name: "hero-clip",
          description: "product hero",
          mediaType: "video",
          workflow,
        }],
      });
    }
    if (target.endsWith("/api/models")) return json(["checkpoints", "loras"]);
    if (target.endsWith("/api/models/checkpoints")) return json([{ name: "hero.safetensors", path: "hero.safetensors" }]);
    if (target.includes("/api/billing/usage/timeseries")) {
      return json({ summary: { spend_micros: 1_000_000, balance: { amount_micros: 1000, currency: "USD" } } });
    }
    if (target.endsWith("/api/v2/assets") && method === "POST") {
      assert.equal(init.body.get("content_type"), "image/png");
      assert.ok(init.body.get("file"));
      return json({ id: "asset-1", content_type: "image/png" }, 201);
    }
    if (target.endsWith("/api/v2/jobs") && method === "POST") {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      inFlight -= 1;
      jobCount += 1;
      const body = JSON.parse(init.body);
      submitted.push(body.workflow);
      return json({ id: `job-${jobCount}`, status: "queued" }, 201);
    }
    const match = target.match(/\/api\/v2\/jobs\/([^/]+)$/);
    if (match) {
      return json({
        id: match[1],
        status: "succeeded",
        progress: { value: 1, nodes_done: 4, nodes_total: 4, message: "done" },
        queue_position: null,
        error: null,
        outputs: [{
          id: "out-1",
          name: "frame.png",
          type: "image",
          url: "https://cloud.comfy.org/api/v2/assets/out-1/content",
          node_id: "9",
        }],
      });
    }
    if (target.includes("/api/v2/assets/out-1/content")) {
      return new Response(Buffer.from("png-bytes"));
    }
    return json({ error: { message: `unexpected ${method} ${target}` } }, 404);
  };
  return {
    fetchImpl,
    submitted,
    get maxInFlight() { return maxInFlight; },
  };
}

async function withServer(fetchState, bridge, fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await buildMcpServer(bridge, {
    clientFactory: () => new ComfyCloudClient({ key: "test-key", fetchImpl: fetchState.fetchImpl }),
  });
  await server.connect(serverTransport);
  const client = new Client({ name: "cloud-test", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

await check("tools say this server is enough and list templates and models", async () => {
  const state = cloudFetch();
  const bridge = { exec: async () => ({ ok: true, result: null }), snapshot: () => ({ connected: true }) };
  await withServer(state, bridge, async (client) => {
    const listed = await client.listTools();
    const generate = listed.tools.find((tool) => tool.name === "comfy_generate");
    const place = listed.tools.find((tool) => tool.name === "ae_generate_and_place");
    assert.match(generate.description, /Do not call a separate/);
    assert.match(place.description, /Do not call a separate/);
    const templates = JSON.parse((await client.callTool({ name: "comfy_list_templates", arguments: { query: "hero" } })).content[0].text);
    assert.equal(templates.ok, true);
    assert.equal(templates.templates[0].name, "hero-clip");
    const models = JSON.parse((await client.callTool({ name: "comfy_list_models", arguments: {} })).content[0].text);
    assert.deepEqual(models.folders, ["checkpoints", "loras"]);
    const files = JSON.parse((await client.callTool({ name: "comfy_list_models", arguments: { folder: "checkpoints" } })).content[0].text);
    assert.equal(files.models[0].name, "hero.safetensors");
  });
});

await check("generate uploads, polls, downloads, and keeps concurrency at 1", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cab-cloud-"));
  const image = path.join(dir, "still.png");
  fs.writeFileSync(image, "png");
  const state = cloudFetch();
  const bridge = { exec: async () => ({ ok: true }), snapshot: () => ({}) };
  await withServer(state, bridge, async (client) => {
    const raw = await client.callTool({
      name: "comfy_generate",
      arguments: {
        template: "hero-clip",
        prompt: "a product hero, no logo",
        seed: 10,
        width: 1280,
        height: 720,
        duration_seconds: 4,
        images: [image],
        variants: 2,
        concurrency: 1,
        output_dir: dir,
      },
    });
    const body = JSON.parse(raw.content[0].text);
    assert.equal(body.ok, true);
    assert.equal(state.maxInFlight, 1);
    assert.equal(state.submitted.length, 2);
    assert.equal(state.submitted[0]["6"].inputs.text, "a product hero, no logo");
    assert.equal(state.submitted[0]["7"].inputs.text, "bad");
    assert.equal(state.submitted[0]["3"].inputs.seed, 10);
    assert.equal(state.submitted[1]["3"].inputs.seed, 11);
    assert.equal(state.submitted[0]["9"].inputs.duration, 4);
    assert.equal(body.credits.balance.availableUsd, 10);
    assert.equal(body.jobs[0].files[0].bytes, Buffer.from("png-bytes").length);
    assert.equal(fs.existsSync(body.jobs[0].files[0].path), true);
  });
});

await check("ae_generate_and_place downloads then sends the file to After Effects", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cab-place-"));
  const project = path.join(dir, "project");
  fs.mkdirSync(project);
  const state = cloudFetch({ delayMs: 5 });
  const placed = [];
  const bridge = {
    snapshot: () => ({ connected: true, transport: "direct" }),
    exec: async (jsx) => {
      const text = String(jsx);
      if (text.includes("parent.fsName") && !text.includes("ae_place_variants")) {
        return { ok: true, result: project, project: path.join(project, "Launch.aep") };
      }
      placed.push(text);
      return { ok: true, result: { queued: [{ output: path.join(project, "v1_16x9.mp4"), rqIndex: 1 }] }, project: path.join(project, "Launch.aep") };
    },
  };
  await withServer(state, bridge, async (client) => {
    const raw = await client.callTool({
      name: "ae_generate_and_place",
      arguments: {
        workflow,
        prompt: "hero",
        template_comp: "Launch_Master",
        placeholder_layer: "MEDIA",
        variants: 1,
        concurrency: 1,
      },
    });
    const body = JSON.parse(raw.content[0].text);
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(placed.length, 1);
    assert.match(placed[0], /Launch_Master/);
    assert.match(placed[0], /MEDIA/);
    assert.match(placed[0], /v1-frame\.png/);
  });
});

await check("empty template list still offers built-in z-image-turbo", async () => {
  const client = new ComfyCloudClient({
    key: "test-key",
    fetchImpl: async () => json({}),
  });
  const listed = await client.listTemplates();
  assert.equal(listed.templates.length, 1);
  assert.equal(listed.templates[0].name, "z-image-turbo");
  assert.equal(listed.templates[0].workflow["1"].inputs.unet_name, "z_image_turbo_bf16.safetensors");
  assert.equal(listed.templates[0].workflow["2"].inputs.clip_name, "qwen_3_4b.safetensors");
  assert.equal(listed.templates[0].workflow["2"].inputs.type, "lumina2");
  assert.equal(listed.templates[0].workflow["3"].inputs.vae_name, "ae.safetensors");
  assert.equal(listed.templates[0].workflow["8"].inputs.steps, 8);
});

await check("generate with no template runs z-image-turbo", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cab-zimage-"));
  const state = cloudFetch({ delayMs: 0 });
  const bridge = { exec: async () => ({ ok: true }), snapshot: () => ({}) };
  await withServer(state, bridge, async (client) => {
    const raw = await client.callTool({
      name: "comfy_generate",
      arguments: { prompt: "a red square", seed: 3, output_dir: dir, variants: 1, concurrency: 1 },
    });
    const body = JSON.parse(raw.content[0].text);
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(state.submitted[0]["1"].inputs.unet_name, "z_image_turbo_bf16.safetensors");
    assert.equal(state.submitted[0]["4"].inputs.text, "a red square");
    assert.equal(state.submitted[0]["8"].inputs.steps, 8);
    assert.equal(state.submitted[0]["8"].inputs.seed, 3);
  });
});

await check("download prefers https asset content and drops auth off-origin", async () => {
  assert.equal(
    contentUrlFor({ id: "asset-9", url: "http://cloud.comfy.org/api/v2/assets/asset-9/content" }),
    "https://cloud.comfy.org/api/v2/assets/asset-9/content",
  );
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), auth: init.headers?.Authorization || "", redirect: init.redirect });
    const target = String(url);
    if (target === "https://cloud.comfy.org/api/v2/assets/asset-9/content") {
      return new Response(Buffer.from("by-id"));
    }
    if (target === "https://cloud.comfy.org/api/view?filename=a.png") {
      return new Response(null, { status: 302, headers: { location: "https://storage.example/a.png" } });
    }
    if (target === "https://storage.example/a.png") {
      return new Response(Buffer.from("by-storage"));
    }
    return new Response("nope", { status: 401 });
  };
  const client = new ComfyCloudClient({ key: "test-key", fetchImpl });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cab-dl-"));
  const byId = await client.downloadOutputs({
    outputs: [{ id: "asset-9", name: "frame.png", type: "image", url: "http://cloud.comfy.org/api/v2/assets/asset-9/content" }],
  }, dir, "v1");
  assert.equal(byId[0].bytes, Buffer.from("by-id").length);
  assert.equal(calls[0].url, "https://cloud.comfy.org/api/v2/assets/asset-9/content");
  assert.match(calls[0].auth, /test-key/);
  assert.equal(calls[0].redirect, "manual");

  const before = calls.length;
  const byRedirect = await client.downloadOutputs({
    outputs: [{ name: "a.png", type: "image", url: "http://cloud.comfy.org/api/view?filename=a.png" }],
  }, dir, "v2");
  assert.equal(byRedirect[0].bytes, Buffer.from("by-storage").length);
  assert.equal(calls[before].url, "https://cloud.comfy.org/api/view?filename=a.png");
  assert.match(calls[before].auth, /test-key/);
  assert.equal(calls[before + 1].url, "https://storage.example/a.png");
  assert.equal(calls[before + 1].auth, "");
});

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\ncloud ok");
