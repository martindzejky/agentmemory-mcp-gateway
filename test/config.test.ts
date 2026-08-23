import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, assertSafeDatabasePath, loadGatewayConfig } from "../src/config.js";
import { AUTH_SECRET, BACKEND_SECRET, baseEnv } from "./helpers.js";

describe("assertSafeDatabasePath", () => {
  it("rejects relative paths and filesystem-root parents", () => {
    expect(() => assertSafeDatabasePath("oauth.sqlite")).toThrow(ConfigError);
    expect(() => assertSafeDatabasePath("/oauth.sqlite")).toThrow(/filesystem root/i);
    expect(() => assertSafeDatabasePath("/")).toThrow(ConfigError);
  });

  it("requires production paths to stay under the volume mount", () => {
    expect(() =>
      assertSafeDatabasePath("/tmp/oauth.sqlite", { isProduction: true, volumeMount: "/data" }),
    ).toThrow(/under \/data/i);
    expect(() =>
      assertSafeDatabasePath("/data", { isProduction: true, volumeMount: "/data" }),
    ).toThrow(ConfigError);
    expect(
      assertSafeDatabasePath("/data/oauth.sqlite", { isProduction: true, volumeMount: "/data" }),
    ).toBe("/data/oauth.sqlite");
  });

  it("allows non-production temp paths used by tests", () => {
    const path = join(mkdtempSync(join(tmpdir(), "amg-")), "oauth.sqlite");
    expect(assertSafeDatabasePath(path, { isProduction: false })).toBe(path);
  });
});

describe("loadGatewayConfig database path", () => {
  it("rejects a production database file in /", () => {
    expect(() =>
      loadGatewayConfig({
        ...baseEnv(),
        NODE_ENV: "production",
        PUBLIC_URL: "https://memory-mcp.example.com",
        BETTER_AUTH_SECRET: AUTH_SECRET,
        AGENTMEMORY_SECRET: BACKEND_SECRET,
        DATABASE_PATH: "/oauth.sqlite",
      }),
    ).toThrow(/filesystem root|under \/data/i);
  });
});
