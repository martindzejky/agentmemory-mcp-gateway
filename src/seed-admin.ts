import { loadSeedConfig } from "./config.js";
import { createGatewayAuth } from "./auth.js";
import { listUsers } from "./db.js";

export async function seedAdmin(env: NodeJS.ProcessEnv = process.env): Promise<{ userId: string }> {
  const config = loadSeedConfig(env);
  const gateway = await createGatewayAuth(config, {
    allowUserCreation: true,
    requireSoleUser: false,
  });

  try {
    const existing = listUsers(gateway.db);
    if (existing.length > 0) {
      throw new Error("Refusing to seed: a user already exists");
    }

    const created = await gateway.auth.api.signUpEmail({
      body: {
        email: config.adminEmail,
        password: config.adminPassword,
        name: "Administrator",
      },
    });

    const userId = created.user.id;
    if (!userId) {
      throw new Error("Seed did not return a user id");
    }

    const users = listUsers(gateway.db);
    if (users.length !== 1 || users[0]?.id !== userId) {
      throw new Error("Seed did not leave exactly one user");
    }

    await gateway.auth.$context;
    return { userId };
  } finally {
    gateway.db.close();
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url.endsWith(entry.replace(/\\/g, "/")));
}

if (
  isMain() ||
  process.argv[1]?.endsWith("seed-admin.ts") ||
  process.argv[1]?.endsWith("seed-admin.js")
) {
  seedAdmin()
    .then(({ userId }) => {
      console.log(`Administrator created. Durable user ID: ${userId}`);
      console.log("Remove ADMIN_PASSWORD (and ADMIN_EMAIL) from the environment now.");
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Seed failed";
      console.error(message.includes("PASSWORD") ? "Seed failed" : message);
      process.exitCode = 1;
    });
}
