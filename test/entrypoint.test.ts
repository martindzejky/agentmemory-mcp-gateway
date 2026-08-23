import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ENTRYPOINT = join(process.cwd(), "docker-entrypoint.sh");

function runEntrypoint(env: NodeJS.ProcessEnv): { status: number | null; stderr: string } {
  const result = spawnSync(ENTRYPOINT, ["true"], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr };
}

describe("docker-entrypoint database path", () => {
  it("rejects a database file whose parent is /", () => {
    const result = runEntrypoint({
      DATABASE_PATH: "/oauth.sqlite",
      RAILWAY_VOLUME_MOUNT_PATH: "/data",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/under \/data|unsafe/i);
  });

  it("rejects a path that escapes the volume mount", () => {
    const result = runEntrypoint({
      DATABASE_PATH: "/data/../oauth.sqlite",
      RAILWAY_VOLUME_MOUNT_PATH: "/data",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/under \/data/i);
  });

  it("accepts an absolute file under the mounted directory", () => {
    const mount = mkdtempSync(join(tmpdir(), "amg-vol-"));
    const databasePath = join(mount, "oauth.sqlite");
    writeFileSync(databasePath, "");
    writeFileSync(`${databasePath}-wal`, "");
    const result = runEntrypoint({
      DATABASE_PATH: databasePath,
      RAILWAY_VOLUME_MOUNT_PATH: mount,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
