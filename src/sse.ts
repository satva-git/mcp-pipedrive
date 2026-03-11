#!/usr/bin/env node
import http from "node:http";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createPipedriveServer } from "./server-factory.js";
import { logger } from "./utils/logger.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const READ_ONLY = process.env.PIPEDRIVE_READ_ONLY === "true";
const enabledToolsets = process.env.PIPEDRIVE_TOOLSETS
  ? process.env.PIPEDRIVE_TOOLSETS.split(",").map((t) => t.trim())
  : undefined;

/**
 * Resolve the Pipedrive API token for a request.
 * Priority: Authorization header > X-Pipedrive-Token header > ?token= query > PIPEDRIVE_API_TOKEN env
 */
function resolveApiToken(req: http.IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const hdr = req.headers["x-pipedrive-token"];
  if (hdr) return Array.isArray(hdr) ? hdr[0] : hdr;
  const url = new URL(req.url || "/", "http://" + (req.headers.host || "localhost"));
  const qToken = url.searchParams.get("token");
  if (qToken) return qToken;
  return process.env.PIPEDRIVE_API_TOKEN;
}

const transports = new Map<string, SSEServerTransport>();

const httpServer = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Pipedrive-Token");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url || "/", "http://" + (req.headers.host || "localhost"));

  // Health check
  if (url.pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", connections: transports.size }));
    return;
  }

  // SSE endpoint — each connection gets its own MCP server + Pipedrive client
  if (url.pathname === "/sse" && req.method === "GET") {
    const apiToken = resolveApiToken(req);
    if (!apiToken) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing Pipedrive API token. Provide via Authorization: Bearer <token>, X-Pipedrive-Token header, ?token= query param, or PIPEDRIVE_API_TOKEN env var." }));
      return;
    }
    logger.info("New SSE connection", { ip: req.socket.remoteAddress });
    const server = createPipedriveServer({ apiToken, readOnly: READ_ONLY, enabledToolsets });
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);
    logger.info("SSE session started", { sessionId: transport.sessionId });
    res.on("close", () => {
      transports.delete(transport.sessionId);
      logger.info("SSE session closed", { sessionId: transport.sessionId });
      server.close().catch(() => {});
    });
    await server.connect(transport);
    return;
  }

  // Message endpoint
  if (url.pathname === "/messages" && req.method === "POST") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing sessionId query parameter" }));
      return;
    }
    const transport = transports.get(sessionId);
    if (!transport) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found. It may have expired." }));
      return;
    }
    await transport.handlePostMessage(req, res);
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found", endpoints: { "GET /sse": "SSE connection", "POST /messages?sessionId=...": "MCP messages", "GET /health": "Health check" } }));
});

httpServer.listen(PORT, HOST, () => {
  logger.info("Pipedrive MCP SSE server listening on http://" + HOST + ":" + PORT);
  logger.info("  GET  /sse       — SSE connection (multi-user, pass API token per connection)");
  logger.info("  POST /messages  — MCP messages");
  logger.info("  GET  /health    — Health check");
  if (process.env.PIPEDRIVE_API_TOKEN) logger.info("Fallback token configured via env");
  else logger.info("No fallback token — each client must provide their own");
});

function shutdown(signal: string) {
  logger.info("Shutting down (" + signal + ")...");
  for (const [id] of transports) transports.delete(id);
  httpServer.close(() => { logger.info("Server closed"); process.exit(0); });
  setTimeout(() => process.exit(1), 5000);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => { logger.error("Uncaught exception", err); process.exit(1); });
process.on("unhandledRejection", (r) => { logger.error("Unhandled rejection", new Error(String(r))); process.exit(1); });