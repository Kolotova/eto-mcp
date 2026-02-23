import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";

import { config } from "./config.js";
import { createMcpServer } from "./mcp.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicAssetsRoot = path.resolve(__dirname, "../public/assets");

function contentTypeByExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

export function createHttpServer(logger: Logger) {
  const fastify = Fastify({ loggerInstance: logger });

  fastify.register(rateLimit);

  fastify.get("/", async () => ({
    service: "triply-mcp",
    health: "/health",
    mcp: "/mcp"
  }));

  fastify.get("/health", async () => ({ status: "ok" }));

  fastify.get("/assets/*", async (request, reply) => {
    const wildcard = ((request.params as { "*": string })["*"] ?? "").trim();
    const normalized = path.normalize(wildcard).replace(/^(\.\.(\/|\\|$))+/, "");
    const filePath = path.resolve(publicAssetsRoot, normalized);

    if (!filePath.startsWith(publicAssetsRoot)) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return reply.code(404).send({ error: "Not Found" });
    }

    return reply.type(contentTypeByExt(filePath)).send(createReadStream(filePath));
  });

  fastify.post(
    "/mcp",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
          keyGenerator: (request: { ip: string }) => request.ip
        }
      }
    },
    async (request, reply) => {
      const apiKey = request.headers["x-api-key"];
      if (apiKey !== config.API_KEY) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      });

      reply.raw.on("close", () => {
        transport.close().catch(() => undefined);
        mcpServer.close().catch(() => undefined);
      });

      await mcpServer.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);

      return reply;
    }
  );

  fastify.get("/mcp", async (_request, reply) => {
    return reply.code(405).send({ error: "Use MCP JSON-RPC over SSE/POST" });
  });

  return fastify;
}
