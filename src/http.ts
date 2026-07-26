/**
 * Streamable HTTP transport — the remote-hosted entry point.
 *
 * Stateless: a fresh McpServer + transport is created per request
 * (sessionIdGenerator: undefined, enableJsonResponse: true). This is the
 * simplest model to scale horizontally behind a load balancer and is what most
 * remote MCP platforms expect. The MCP endpoint is POST /mcp.
 *
 * No auth here by design — this server runs behind a gateway that terminates
 * auth. It should NOT be exposed to the public internet directly.
 */

import express, { type Express, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { config } from "./config.js";

export function isAllowedMcpOrigin(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  // CLI/agent clients do not normally send Origin. Browsers must be explicitly allowed.
  return origin === undefined || allowedOrigins.includes(origin);
}

export function createHttpApp(): Express {
  const app = express();
  if (config.httpTrustProxy) app.set("trust proxy", 1);
  app.use(express.json({ limit: "2mb" }));

  // Health check (useful for platform liveness probes).
  app.get("/health", (_req, res) => {
    res.json({ ok: true, server: SERVER_NAME, version: SERVER_VERSION });
  });

  // MCP endpoint — stateless POST. Auth is handled by the gateway in front.
  app.use("/mcp", (req: Request, res: Response, next) => {
    if (!isAllowedMcpOrigin(req.get("origin"), config.httpAllowedOrigins)) {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Origin is not allowed." },
        id: null,
      });
      return;
    }
    next();
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
      // eslint-disable-next-line no-console
      console.error("Error handling /mcp request:", error);
    }
  });

  // Stateless server: GET (SSE) and DELETE (session teardown) are not supported.
  const methodNotAllowed = (_req: Request, res: Response) =>
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. This server is stateless; use POST /mcp." },
      id: null,
    });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app;
}

export async function runHttp(): Promise<void> {
  const app = createHttpApp();

  await new Promise<void>((resolve) => {
    app.listen(config.port, config.httpHost, () => {
      // eslint-disable-next-line no-console
      console.error(
        `${SERVER_NAME} (HTTP) listening on http://${config.httpHost}:${config.port}/mcp${
          config.httpTrustProxy ? " (gateway mode)" : " (loopback only)"
        }`
      );
      resolve();
    });
  });
}
