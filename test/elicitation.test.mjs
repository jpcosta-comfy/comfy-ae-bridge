import assert from "node:assert/strict";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  CloudMcpClient,
  CLOUD_CLIENT_CAPABILITIES,
  SPEND_DIALOG_NOTE,
  forwardElicitation,
  withoutAgentSpendConsent,
} from "../src/comfy-mcp.js";

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

const SPEND_PARAMS = {
  message: "This run spends 12 credits.",
  requestedSchema: {
    type: "object",
    properties: {
      confirm: { type: "boolean", title: "Spend credits" },
    },
    required: ["confirm"],
  },
};

async function userSession(capabilities, respond) {
  const bridge = new McpServer({ name: "comfy-ae-bridge", version: "0.1.1" });
  const user = new Client({ name: "claude-code", version: "0.0.0" }, { capabilities: capabilities || {} });
  const seen = [];
  if (capabilities?.elicitation && respond) {
    user.setRequestHandler(ElicitRequestSchema, async (request) => {
      seen.push(request.params);
      return respond(request);
    });
  }
  const [userTransport, bridgeTransport] = InMemoryTransport.createLinkedPair();
  await bridge.connect(bridgeTransport);
  await user.connect(userTransport);
  return {
    bridge,
    seen,
    async close() {
      await user.close();
      await bridge.close();
    },
  };
}

async function cloudThatElicits(upstream) {
  const cloud = new McpServer({ name: "comfy-cloud", version: "0.0.0" });
  let answer;
  cloud.registerTool(
    "run_template",
    { inputSchema: { name: z.string().optional() } },
    async () => {
      answer = await cloud.server.elicitInput(SPEND_PARAMS);
      return { content: [{ type: "text", text: JSON.stringify(answer) }] };
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await cloud.connect(serverTransport);
  const session = new CloudMcpClient({
    apiKey: "test-key",
    transport: clientTransport,
    upstream: upstream.bridge,
  });
  await session.connect();
  return {
    session,
    cloud,
    answer: () => answer,
    async close() {
      await session.close();
      await cloud.close();
    },
  };
}

function assertPassthrough(answer, expected) {
  assert.equal(answer.action, expected.action);
  assert.deepEqual(answer.content, expected.content);
}

await check("cloud client declares elicitation and forwards an accept with content", async () => {
  const expected = { action: "accept", content: { confirm: true } };
  const user = await userSession({ elicitation: { form: {} } }, async () => expected);
  const cloud = await cloudThatElicits(user);
  try {
    const caps = cloud.cloud.server.getClientCapabilities();
    assert.deepEqual(caps.elicitation, CLOUD_CLIENT_CAPABILITIES.elicitation);
    await cloud.session.callTool("run_template", { name: "image_z_image_turbo" });
    assertPassthrough(cloud.answer(), expected);
    assert.equal(user.seen.length, 1);
    assert.equal(user.seen[0].message, SPEND_PARAMS.message);
    assert.deepEqual(user.seen[0].requestedSchema, SPEND_PARAMS.requestedSchema);
  } finally {
    await cloud.close();
    await user.close();
  }
});

await check("a decline from the user is returned to Cloud unchanged", async () => {
  const expected = { action: "decline" };
  const user = await userSession({ elicitation: { form: {}, url: {} } }, async () => expected);
  const cloud = await cloudThatElicits(user);
  try {
    await cloud.session.callTool("run_template", { name: "image_z_image_turbo" });
    assert.equal(cloud.answer().action, "decline");
    assert.equal(cloud.answer().content, undefined);
    assert.equal(user.seen.length, 1);
  } finally {
    await cloud.close();
    await user.close();
  }
});

await check("a cancel from the user is returned to Cloud unchanged", async () => {
  const expected = { action: "cancel" };
  const user = await userSession({ elicitation: { form: {} } }, async () => expected);
  const cloud = await cloudThatElicits(user);
  try {
    await cloud.session.callTool("run_template", { name: "image_z_image_turbo" });
    assert.equal(cloud.answer().action, "cancel");
    assert.equal(cloud.answer().content, undefined);
  } finally {
    await cloud.close();
    await user.close();
  }
});

await check("an upstream client without elicitation is declined and never asked", async () => {
  const user = await userSession({}, async () => ({ action: "accept", content: { confirm: true } }));
  const cloud = await cloudThatElicits(user);
  try {
    await cloud.session.callTool("run_template", { name: "image_z_image_turbo" });
    assert.equal(cloud.answer().action, "decline");
    assert.equal(cloud.answer().content, undefined);
    assert.equal(user.seen.length, 0);
  } finally {
    await cloud.close();
    await user.close();
  }
});

await check("a bare elicitation capability still forwards the form to the user", async () => {
  const expected = { action: "accept", content: { confirm: true } };
  const user = await userSession({ elicitation: {} }, async () => expected);
  const cloud = await cloudThatElicits(user);
  try {
    await cloud.session.callTool("run_template", { name: "image_z_image_turbo" });
    assertPassthrough(cloud.answer(), expected);
    assert.equal(user.seen[0].message, SPEND_PARAMS.message);
  } finally {
    await cloud.close();
    await user.close();
  }
});

await check("forwardElicitation declines when there is no upstream session", async () => {
  const result = await forwardElicitation(null, { params: SPEND_PARAMS });
  assert.deepEqual(result, { action: "decline" });
  let called = false;
  const declined = await forwardElicitation({
    getClientCapabilities: () => ({}),
    elicitInput: async () => {
      called = true;
      return { action: "accept", content: { confirm: true } };
    },
  }, { params: SPEND_PARAMS });
  assert.equal(called, false);
  assert.deepEqual(declined, { action: "decline" });
  const thrown = await forwardElicitation({
    getClientCapabilities: () => ({ elicitation: { form: {} } }),
    elicitInput: async () => {
      throw new Error("Client does not support form elicitation.");
    },
  }, { params: SPEND_PARAMS });
  assert.deepEqual(thrown, { action: "decline" });
  await assert.rejects(
    () => forwardElicitation({
      getClientCapabilities: () => ({ elicitation: { form: {} } }),
      elicitInput: async () => {
        throw new Error("socket closed");
      },
    }, { params: SPEND_PARAMS }),
    /socket closed/,
  );
});

await check("instructions no longer tell the agent to set confirm", () => {
  const files = [
    "skills/comfy-ae-bridge/SKILL.md",
    "README.md",
    "src/comfy-mcp.js",
    "src/server.js",
    "src/cloud-tools.js",
  ];
  const banned = /confirm-spend flag|Confirm spend before a paid run|set `confirm:\s*true`|pre-approve spend/i;
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(text, banned, file);
  }
  const skill = fs.readFileSync("skills/comfy-ae-bridge/SKILL.md", "utf8");
  const readme = fs.readFileSync("README.md", "utf8");
  assert.match(skill, /confirmation dialog to the user/);
  assert.match(readme, /confirmation dialog to the user/);
  assert.equal(
    withoutAgentSpendConsent("Run it. Set confirm to true before the call. Then wait."),
    "Run it. Then wait.",
  );
  assert.match(SPEND_DIALOG_NOTE, /confirmation dialog/);
});

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nelicitation ok");
