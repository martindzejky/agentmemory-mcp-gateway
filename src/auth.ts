import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { APIError } from "better-auth/api";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { jwt } from "better-auth/plugins";
import type { GatewayConfig } from "./config.js";
import { listUsers, openSqlite, type UserRow } from "./db.js";

const MCP_SCOPES = ["openid", "profile", "offline_access", "mcp:tools"] as const;
const BLOCKED_AUTH_PATHS = [
  "/sign-up",
  "/sign-up/email",
  "/request-password-reset",
  "/request-password-reset/callback",
  "/reset-password",
  "/forget-password",
  "/change-password",
  "/change-email",
  "/delete-user",
  "/delete-user/callback",
  "/token",
] as const;

export interface AuthFactoryOptions {
  allowUserCreation?: boolean;
  requireSoleUser?: boolean;
}

type AuthInstance = ReturnType<typeof createBetterAuth>["auth"];

export interface GatewayAuth {
  auth: AuthInstance;
  db: ReturnType<typeof openSqlite>;
  adminUser: UserRow | null;
}

function createBetterAuth(
  config: GatewayConfig,
  options: AuthFactoryOptions,
  db: ReturnType<typeof openSqlite>,
) {
  const allowUserCreation = options.allowUserCreation === true;

  const auth = betterAuth({
    baseURL: config.publicUrl,
    basePath: "/",
    secret: config.betterAuthSecret,
    database: db,
    trustedOrigins: [config.publicOrigin],
    disabledPaths: [...BLOCKED_AUTH_PATHS],
    emailAndPassword: {
      enabled: true,
      disableSignUp: !allowUserCreation,
      minPasswordLength: 20,
      maxPasswordLength: 128,
      autoSignIn: false,
    },
    session: {
      expiresIn: 60 * 60 * 8,
      updateAge: 60 * 30,
    },
    advanced: {
      useSecureCookies: config.isProduction || config.publicUrl.startsWith("https://"),
      trustedProxyHeaders: config.trustedProxyHeaders,
    },
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            if (!allowUserCreation) {
              throw new APIError("FORBIDDEN", { message: "Request denied" });
            }
            const existing = listUsers(db);
            if (existing.length > 0) {
              throw new APIError("FORBIDDEN", { message: "Request denied" });
            }
            return;
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const users = listUsers(db);
            const admin = users.length === 1 ? users[0] : undefined;
            if (!admin || session.userId !== admin.id) {
              throw new APIError("UNAUTHORIZED", { message: "Invalid email or password" });
            }
            return;
          },
        },
      },
    },
    plugins: [
      jwt({
        disableSettingJwtHeader: true,
        jwt: {
          issuer: config.publicUrl,
          audience: config.mcpResource,
          expirationTime: "5m",
        },
      }),
      mcp({
        loginPage: "/sign-in",
        consentPage: "/consent",
        resource: config.mcpResource,
        scopes: [...MCP_SCOPES],
        accessTokenExpiresIn: 300,
        refreshTokenExpiresIn: 60 * 60 * 24 * 7,
        codeExpiresIn: 60,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        grantTypes: ["authorization_code", "refresh_token"],
      }),
      cimd({
        fetchClientMetadataResource,
        metadataProfile: "mcp-2026-07-28",
      }),
    ],
  });

  return { auth, db };
}

export async function migrateAuth(
  config: GatewayConfig,
  db: ReturnType<typeof openSqlite>,
): Promise<void> {
  const { runMigrations } = await getMigrations({
    baseURL: config.publicUrl,
    basePath: "/",
    secret: config.betterAuthSecret,
    database: db,
    emailAndPassword: { enabled: true, disableSignUp: true },
    plugins: [
      jwt({ disableSettingJwtHeader: true }),
      mcp({
        loginPage: "/sign-in",
        consentPage: "/consent",
        resource: config.mcpResource,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }),
      cimd({
        fetchClientMetadataResource,
        metadataProfile: "mcp-2026-07-28",
      }),
    ],
  });
  await runMigrations();
}

export function requireSoleAdmin(db: ReturnType<typeof openSqlite>): UserRow {
  const users = listUsers(db);
  if (users.length !== 1 || !users[0]) {
    throw new Error("Gateway database must contain exactly one human user");
  }
  return users[0];
}

export function isAdminSubject(adminUserId: string, subject: unknown): boolean {
  return typeof subject === "string" && subject.length > 0 && subject === adminUserId;
}

export async function createGatewayAuth(
  config: GatewayConfig,
  options: AuthFactoryOptions = {},
): Promise<GatewayAuth> {
  const db = openSqlite(config.databasePath);
  await migrateAuth(config, db);
  const { auth } = createBetterAuth(config, options, db);
  await auth.$context;
  const users = listUsers(db);
  if (options.requireSoleUser !== false && !options.allowUserCreation) {
    return { auth, db, adminUser: requireSoleAdmin(db) };
  }
  return { auth, db, adminUser: users.length === 1 ? (users[0] ?? null) : null };
}

export { MCP_SCOPES, BLOCKED_AUTH_PATHS };
