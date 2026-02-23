import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { TtlCache } from "./cache.js";
import { formatToursForTelegram } from "./formatters/telegram.js";
import { mockSearchTours } from "./mockSearch.js";
import { searchToursInputSchema } from "./schemas.js";
import { createSearch, normalize, pollResults } from "./tourvisor.js";
import type { SearchToursOutput } from "./types.js";

const cache = new TtlCache<SearchToursOutput>(60_000);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "eto-mcp",
    version: "1.0.0"
  });

  server.registerTool(
    "search_tours",
    {
      title: "Search Tours",
      description: "Search tours using Tourvisor and return normalized results.",
      inputSchema: searchToursInputSchema.shape
    },
    async (input) => {
      const rawInput = asRecord(input);
      const parsed = searchToursInputSchema.parse(rawInput);

      if (process.env.DATA_PROVIDER === "mock") {
        const mockInput = { ...rawInput, ...parsed };
        const cacheKey = JSON.stringify(mockInput);
        const cached = cache.get(cacheKey);

        if (cached) {
          const text = formatToursForTelegram(cached, { top: 5 });
          return {
            content: [{ type: "text", text }],
            structuredContent: cached
          };
        }

        const output = await mockSearchTours(mockInput);
        const text = formatToursForTelegram(output, { top: 5 });
        cache.set(cacheKey, output);

        return {
          content: [{ type: "text", text }],
          structuredContent: output
        };
      }

      const cacheKey = JSON.stringify(parsed);
      const cached = cache.get(cacheKey);
      if (cached) {
        const text = formatToursForTelegram(cached, { top: 5 });
        return {
          content: [{ type: "text", text }],
          structuredContent: cached
        };
      }

      const startedAt = Date.now();
      const requestid = await createSearch(parsed);
      const polled = await pollResults(requestid, { intervalMs: 1500, timeoutMs: 20_000 });
      const results = normalize(polled.raw);

      const output: SearchToursOutput = {
        requestid,
        results,
        meta: {
          timed_out: polled.timedOut,
          polls: polled.polls,
          ms: Date.now() - startedAt
        }
      };

      cache.set(cacheKey, output);
      const text = formatToursForTelegram(output, { top: 5 });

      return {
        content: [{ type: "text", text }],
        structuredContent: output
      };
    }
  );

  return server;
}
