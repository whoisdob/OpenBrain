/**
 * Open Brain — Entry Point
 *
 * Starts both:
 * 1. Hono REST API server (port 8000)
 * 2. MCP SSE server via raw Node.js HTTP (port 8080)
 *
 * The REST API provides direct HTTP access for testing, Slack webhooks,
 * and any non-MCP integrations.
 *
 * The MCP server is the primary interface for AI tools (Claude, ChatGPT, etc).
 * It uses SSE transport over a raw Node.js HTTP server because
 * SSEServerTransport requires Node.js ServerResponse objects (not Web API).
 */

import http from "node:http";
import { serve } from "@hono/node-server";

import { initializeDatabase, closePool, getPool } from "./db/connection.js";
import { createApi } from "./api/routes.js";
import { createMcpServer, type AgentIdentity } from "./mcp/server.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║           Open Brain v1.0.0              ║");
  console.log("║    Personal Semantic Memory System       ║");
  console.log("╚══════════════════════════════════════════╝");

  // Initialize database connection pool
  await initializeDatabase();

  // ── REST API Server (Hono) ──────────────────────────────────────

  const api = createApi();
  const apiPort = parseInt(process.env.API_PORT ?? "8000", 10);

  serve({ fetch: api.fetch, port: apiPort }, () => {
    console.log(`[api] REST API listening on http://0.0.0.0:${apiPort}`);
    console.log(`[api]   POST /memories         — capture thought`);
    console.log(`[api]   POST /memories/batch    — batch capture`);
    console.log(`[api]   POST /memories/search   — semantic search`);
    console.log(`[api]   POST /memories/list     — filtered listing`);
    console.log(`[api]   PUT  /memories/:id      — update thought`);
    console.log(`[api]   DELETE /memories/:id     — delete thought`);
    console.log(`[api]   GET  /stats             — brain statistics`);
    console.log(`[api]   GET  /health            — health check`);
  });

  // ── MCP Server (SSE over raw Node.js HTTP) ─────────────────────

  const mcpPort = parseInt(process.env.MCP_PORT ?? "8080", 10);
  const mcpAccessKey = process.env.MCP_ACCESS_KEY ?? "";

  // lsje39 / D-103: map each per-agent MCP key to an agent id. The legacy
  // MCP_ACCESS_KEY is Dan's (main); MCP_ACCESS_KEY_NICOLE is Nicole's. read_scope
  // is resolved live from user_config (the seed in scripts/read-scope.py), so the
  // single source of truth stays the DB row — not duplicated here.
  const keyToAgent = new Map<string, string>();
  if (mcpAccessKey) keyToAgent.set(mcpAccessKey, "dan");
  if (process.env.MCP_ACCESS_KEY_NICOLE)
    keyToAgent.set(process.env.MCP_ACCESS_KEY_NICOLE, "nicole");

  async function resolveIdentity(
    key: string | null
  ): Promise<AgentIdentity | undefined> {
    if (!key) return undefined;
    const agent = keyToAgent.get(key);
    if (!agent) return undefined;
    try {
      const { rows } = await getPool().query(
        "SELECT value FROM user_config WHERE user_id = $1 AND key = 'read_scope'",
        [agent]
      );
      const read_scope: string[] = rows[0]?.value ? JSON.parse(rows[0].value) : [];
      return { agent, read_scope };
    } catch (err) {
      // Fail safe for SHADOW: empty scope just logs WOULD-RESTRICT, never blocks.
      console.error(`[scope-shadow] read_scope lookup failed for agent=${agent}:`, err);
      return { agent, read_scope: [] };
    }
  }

  // Track active SSE transports for cleanup
  const transports = new Map<string, SSEServerTransport>();

  const mcpHttpServer = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-brain-key");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${mcpPort}`);

    // Health check — no auth required
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", service: "open-brain-mcp" }));
      return;
    }

    // SSE endpoint — AI clients connect here
    // Auth is checked here; /messages skips the key check because
    // having a valid sessionId proves the client already authenticated.
    if (url.pathname === "/sse" && req.method === "GET") {
      const key =
        (req.headers["x-brain-key"] as string | undefined) ??
        url.searchParams.get("key");
      // Auth: when MCP_ACCESS_KEY is set, only keys mapped to an agent are valid
      // (the legacy key still maps to Dan, so existing clients keep working).
      if (mcpAccessKey && !(key && keyToAgent.has(key))) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      const identity = await resolveIdentity(key);

      const transport = new SSEServerTransport("/messages", res);
      const sessionId = transport.sessionId;
      transports.set(sessionId, transport);

      res.on("close", () => {
        transports.delete(sessionId);
        console.log(`[mcp] SSE session ${sessionId} closed`);
      });

      const server = createMcpServer(identity);
      await server.connect(transport);
      console.log(
        `[mcp] SSE session ${sessionId} connected` +
          (identity ? ` (agent=${identity.agent}, scope=[${identity.read_scope.join(",")}])` : "")
      );
      return;
    }

    // Messages endpoint — receives JSON-RPC calls from AI clients
    if (url.pathname === "/messages" && req.method === "POST") {
      const sessionId = url.searchParams.get("sessionId");
      const transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "No active session. Connect to /sse first." })
        );
        return;
      }

      await transport.handlePostMessage(req, res);
      return;
    }

    // 404 fallback
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  mcpHttpServer.listen(mcpPort, "0.0.0.0", () => {
    console.log(`[mcp] MCP SSE server listening on http://0.0.0.0:${mcpPort}`);
    console.log(`[mcp]   GET  /sse               — SSE connection`);
    console.log(`[mcp]   POST /messages           — JSON-RPC calls`);
    console.log(`[mcp]   GET  /health             — health check`);
    console.log("");
    console.log("[mcp] Connect AI clients to:");
    console.log(`[mcp]   http://<host>:${mcpPort}/sse?key=<MCP_ACCESS_KEY>`);
  });
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[shutdown] Received SIGINT, closing...");
  await closePool();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n[shutdown] Received SIGTERM, closing...");
  await closePool();
  process.exit(0);
});

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
