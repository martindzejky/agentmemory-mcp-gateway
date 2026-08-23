import { describe, expect, it } from "vitest";
import { ADMIN_EMAIL, ADMIN_PASSWORD, baseEnv } from "./helpers.js";
import { seedAdmin } from "../src/seed-admin.js";
import { runStartup, seedCredentialState } from "../src/start.js";

describe("in-container first-run seed", () => {
  it("classifies missing, partial, and complete seed credentials", () => {
    expect(seedCredentialState({})).toBe("none");
    expect(seedCredentialState({ ADMIN_EMAIL: "  " })).toBe("none");
    expect(seedCredentialState({ ADMIN_EMAIL })).toBe("partial");
    expect(seedCredentialState({ ADMIN_PASSWORD })).toBe("partial");
    expect(seedCredentialState({ ADMIN_EMAIL, ADMIN_PASSWORD: "" })).toBe("partial");
    expect(seedCredentialState({ ADMIN_EMAIL, ADMIN_PASSWORD })).toBe("complete");
  });

  it("refuses to start when only ADMIN_EMAIL is set", async () => {
    await expect(runStartup({ ...baseEnv(), ADMIN_EMAIL })).rejects.toThrow(
      /both be set for the one-time seed/i,
    );
  });

  it("refuses to start when only ADMIN_PASSWORD is set", async () => {
    await expect(runStartup({ ...baseEnv(), ADMIN_PASSWORD })).rejects.toThrow(
      /both be set for the one-time seed/i,
    );
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
