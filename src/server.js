import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

export const SERVER_VERSION = "0.1.0";

export const SERVER_INSTRUCTIONS =
  "comfy-ae-bridge is the only server you need. It proxies the official Comfy Cloud MCP (https://cloud.comfy.org/mcp, X-API-Key from COMFY_CLOUD_API_KEY) as comfy_* tools and places the results in After Effects. " +
  "Do not add a separate Comfy Cloud, comfy-mcp, or comfy-cloud connector. " +
  "Paid official runs (comfy_run_template, comfy_submit_workflow, comfy_partner_generate) execute one at a time. Use ae_generate_and_place to generate and place in one call.";

export async function buildMcpServer(link, options = {}) {
  const server = new McpServer(
    { name: "comfy-ae-bridge", version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  await registerTools(server, {
    exec: (jsx, timeoutMs) => link.exec(jsx, timeoutMs),
    status: () => link.snapshot(),
  }, options);
  return server;
}
