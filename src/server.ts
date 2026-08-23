import { serve } from "@hono/node-server";
import { createGatewayApp } from "./app.js";
import { ConfigError, loadGatewayConfig } from "./config.js";
import { safeLog } from "./security.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

export async function startServer(): Promise<void> {
  const config = loadGatewayConfig();
  const gateway = await createGatewayApp(config, { requireSoleUser: true });
  const server = serve({
    fetch: gateway.app.fetch,
    port: config.port,
    hostname: "0.0.0.0",
  });

  safeLog("gateway listening", { port: config.port, resource: config.mcpResource });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    safeLog("gateway shutting down", { signal });
    const timer = setTimeout(() => {
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    server.close(() => {
      gateway.close();
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

function isMain(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url.endsWith(entry.replace(/\\/g, "/")));
}

if (isMain() || process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  startServer().catch((error: unknown) => {
    if (error instanceof ConfigError) {
      console.error(error.message);
    } else {
      console.error("Gateway failed to start");
    }
    process.exit(1);
  });
}
