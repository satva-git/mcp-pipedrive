#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPipedriveServer } from "./server-factory.js";
import { logger } from "./utils/logger.js";
import { metricsCollector } from "./utils/metrics.js";

// Validate environment
const API_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
if (!API_TOKEN) {
  console.error("Error: PIPEDRIVE_API_TOKEN environment variable is required");
  console.error("Get your API token from: https://app.pipedrive.com/settings/api");
  process.exit(1);
}

const READ_ONLY = process.env.PIPEDRIVE_READ_ONLY === "true";
const enabledToolsets = process.env.PIPEDRIVE_TOOLSETS
  ? process.env.PIPEDRIVE_TOOLSETS.split(",").map((t) => t.trim())
  : undefined;

const server = createPipedriveServer({ apiToken: API_TOKEN, readOnly: READ_ONLY, enabledToolsets });

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Pipedrive MCP server started (stdio)");
}

process.on("SIGINT", async () => {
  logger.info("Shutting down (SIGINT)...");
  const metrics = metricsCollector.getMetrics();
  logger.info("Final metrics", metrics as unknown as Record<string, unknown>);
  process.exit(0);
});
process.on("SIGTERM", async () => {
  logger.info("Shutting down (SIGTERM)...");
  process.exit(0);
});
process.on("uncaughtException", (error) => { logger.error("Uncaught exception", error); process.exit(1); });
process.on("unhandledRejection", (reason) => { logger.error("Unhandled rejection", new Error(String(reason))); process.exit(1); });

main().catch((error) => { logger.error("Fatal error", error); process.exit(1); });