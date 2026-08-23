import { describe, expect, it } from "vitest";
import { ADMIN_EMAIL, ADMIN_PASSWORD, baseEnv } from "./helpers.js";
import { seedAdmin } from "../src/seed-admin.js";
import { hasSeedCredentials, runStartup } from "../src/start.js";

describe("in-container first-run seed", () => {
  it("detects seed credentials only when both admin variables are set", () => {
    expect(hasSeedCredentials({})).toBe(false);
    expect(hasSeedCredentials({ ADMIN_EMAIL })).toBe(false);
    expect(hasSeedCredentials({ ADMIN_PASSWORD })).toBe(false);
    expect(hasSeedCredentials({ ADMIN_EMAIL, ADMIN_PASSWORD })).toBe(true);
  });

  it("seeds once from the production start path and then waits for credential removal", async () => {
    const env = {
      ...baseEnv(),
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
    };
    await expect(runStartup(env)).resolves.toBe("seeded");
    await expect(runStartup(env)).resolves.toBe("awaiting-credential-removal");
  });

  it("does not start listening when leftover seed credentials remain after a user exists", async () => {
    const env = {
      ...baseEnv(),
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
    };
    await seedAdmin(env);
    await expect(runStartup(env)).resolves.toBe("awaiting-credential-removal");
  });
});
