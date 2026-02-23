import "dotenv/config";
import pino from "pino";

import { config } from "./config.js";
import { createHttpServer } from "./server.js";

async function main() {
  const logger = pino({
    level: process.env.LOG_LEVEL ?? "info"
  });

  const app = createHttpServer(logger);

  const port = Number(process.env.PORT) || config.PORT;
  const host = "0.0.0.0";

  try {
    await app.listen({ port, host });
    logger.info({ host, port }, "eto-mcp started");
  } catch (error) {
    logger.error({ err: error }, "failed to start eto-mcp");
    process.exit(1);
  }
}

void main();
