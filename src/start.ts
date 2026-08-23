import { ConfigError } from "./config.js";
import { seedAdmin } from "./seed-admin.js";
import { startServer } from "./server.js";

export function hasSeedCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ADMIN_EMAIL?.trim() && env.ADMIN_PASSWORD);
}

export async function runStartup(
  env: NodeJS.ProcessEnv = process.env,
): Promise<"seeded" | "awaiting-credential-removal" | "listening"> {
  if (hasSeedCredentials(env)) {
    try {
      const { userId } = await seedAdmin(env);
      console.log(`Administrator created. Durable user ID: ${userId}`);
      console.log("Remove ADMIN_PASSWORD and ADMIN_EMAIL from the environment, then restart.");
      return "seeded";
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/already exists/i.test(message)) {
        console.error(
          "ADMIN_EMAIL and ADMIN_PASSWORD are set but a user already exists. Remove them, then restart.",
        );
        return "awaiting-credential-removal";
      }
      throw error;
    }
  }
  await startServer();
  return "listening";
}

function isMain(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url.endsWith(entry.replace(/\\/g, "/")));
}

if (isMain() || process.argv[1]?.endsWith("start.ts") || process.argv[1]?.endsWith("start.js")) {
  runStartup()
    .then((mode) => {
      if (mode !== "listening") {
        process.exit(0);
      }
    })
    .catch((error: unknown) => {
      if (error instanceof ConfigError) {
        console.error(error.message);
      } else {
        const message = error instanceof Error ? error.message : "Gateway failed to start";
        console.error(message.includes("PASSWORD") ? "Seed failed" : message);
      }
      process.exit(1);
    });
}
