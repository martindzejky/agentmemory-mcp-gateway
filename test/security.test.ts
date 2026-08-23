import { hashPassword } from "better-auth/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  AUTH_SECRET,
  BACKEND_SECRET,
  baseEnv,
  request,
  startGateway,
} from "./helpers.js";
import { seedAdmin } from "../src/seed-admin.js";
import { listUsers } from "../src/db.js";
import Database from "better-sqlite3";

let restore: (() => void) | undefined;
let close: (() => void) | undefined;

afterEach(() => {
  restore?.();
  close?.();
  restore = undefined;
  close = undefined;
});

describe("single-user seed and HTTP controls", () => {
  it("creates exactly one user and refuses a second seed", async () => {
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(),
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
    };
    const first = await seedAdmin(env);
    expect(first.userId).toMatch(/\S/);
    await expect(seedAdmin(env)).rejects.toThrow(/already exists/i);
    const db = new Database(env.DATABASE_PATH!);
    expect(listUsers(db)).toHaveLength(1);
    db.close();
  });

  it("blocks public signup and user-creation routes", async () => {
    const ctx = await startGateway();
    restore = ctx.restoreFetch;
    close = () => ctx.gateway.close();
    const paths = [
      "/sign-up/email",
      "/sign-up",
      "/admin/oauth2/create-client",
      "/request-password-reset",
    ];
    for (const path of paths) {
      const response = await request(ctx.gateway.app, path, {
        method: "POST",
        host: ctx.config.publicHost,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "intruder@example.com",
          password: "another-password-that-is-long",
          name: "Nope",
        }),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).not.toBe(200);
    }
  });

  it("rejects login for a non-admin subject with a generic error", async () => {
    const ctx = await startGateway();
    restore = ctx.restoreFetch;
    close = () => ctx.gateway.close();
    const passwordHash = await hashPassword("zzzzzzzzzzzzzzzzzzzz");
    ctx.gateway.db
      .prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "intruder-id",
        "Intruder",
        "intruder@example.com",
        0,
        new Date().toISOString(),
        new Date().toISOString(),
      );
    ctx.gateway.db
      .prepare(
        `INSERT INTO account (id, accountId, providerId, issuer, userId, password, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "intruder-account",
        "intruder@example.com",
        "credential",
        "credential",
        "intruder-id",
        passwordHash,
        new Date().toISOString(),
        new Date().toISOString(),
      );

    const response = await request(ctx.gateway.app, "/sign-in", {
      method: "POST",
      host: ctx.config.publicHost,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "intruder@example.com",
        password: "zzzzzzzzzzzzzzzzzzzz",
      }),
      redirect: "manual",
    });
    const body = await response.text();
    expect(body).not.toContain("intruder-id");
    expect(response.status === 303 ? response.headers.get("location") : body).toMatch(
      /error=1|Invalid email or password/i,
    );
  });

  it("does not leak secrets in HTTP responses or captured logs", async () => {
    const logs: string[] = [];
    const info = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const ctx = await startGateway();
    restore = ctx.restoreFetch;
    close = () => {
      ctx.gateway.close();
      info.mockRestore();
      error.mockRestore();
    };

    const response = await request(ctx.gateway.app, "/healthz", { host: ctx.config.publicHost });
    const health = await response.text();
    const discovery = await request(ctx.gateway.app, "/.well-known/oauth-authorization-server", {
      host: ctx.config.publicHost,
    });
    const discoveryText = await discovery.text();
    const captured = [health, discoveryText, logs.join("\n")].join("\n");
    expect(captured).not.toContain(AUTH_SECRET);
    expect(captured).not.toContain(BACKEND_SECRET);
    expect(captured).not.toContain(ADMIN_PASSWORD);
  });
});
