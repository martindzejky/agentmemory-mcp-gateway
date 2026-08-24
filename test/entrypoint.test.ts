import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const VALIDATE = join(process.cwd(), "scripts/validate-database-path.sh");
const ENTRYPOINT = join(process.cwd(), "docker-entrypoint.sh");
const FIXTURE_BIN = join(process.cwd(), "test/fixtures/entrypoint-bin");
const FIXTURE_IMAGE = join(process.cwd(), "test/fixtures/entrypoint-image/Dockerfile");

function runValidate(env: NodeJS.ProcessEnv): { status: number | null; stderr: string } {
  const result = spawnSync("/bin/sh", [VALIDATE], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr };
}

function dockerAvailable(): boolean {
  return spawnSync("docker", ["info"], { encoding: "utf8" }).status === 0;
}

function fileOwnership(path: string): string {
  let result = spawnSync("stat", ["-c", "%u:%g", path], { encoding: "utf8" });
  if (result.status !== 0) {
    result = spawnSync("sudo", ["stat", "-c", "%u:%g", path], { encoding: "utf8" });
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || `stat failed for ${path}`);
  }
  return result.stdout.trim();
}

describe("database path validation", () => {
  it("rejects a database file whose parent is /", () => {
    const result = runValidate({
      DATABASE_PATH: "/oauth.sqlite",
      RAILWAY_VOLUME_MOUNT_PATH: "/data",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/under \/data|unsafe/i);
  });

  it("rejects a path that escapes the volume mount", () => {
    const result = runValidate({
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
    const result = runValidate({
      DATABASE_PATH: databasePath,
      RAILWAY_VOLUME_MOUNT_PATH: mount,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

describe("entrypoint privilege drop fixture", () => {
  it("chowns sqlite files and drops to 10001 without using the host user database", () => {
    const mount = mkdtempSync(join(tmpdir(), "amg-vol-"));
    const databasePath = join(mount, "oauth.sqlite");
    writeFileSync(databasePath, "");
    writeFileSync(`${databasePath}-wal`, "");
    const chownLog = join(mount, "chown.log");
    const setprivLog = join(mount, "setpriv.log");
    const result = spawnSync(ENTRYPOINT, ["true"], {
      env: {
        ...process.env,
        PATH: `${FIXTURE_BIN}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        DATABASE_PATH: databasePath,
        RAILWAY_VOLUME_MOUNT_PATH: mount,
        ENTRYPOINT_CHOWN_LOG: chownLog,
        ENTRYPOINT_SETPRIV_LOG: setprivLog,
      },
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    const chown = spawnSync("/bin/cat", [chownLog], { encoding: "utf8" }).stdout;
    const setpriv = spawnSync("/bin/cat", [setprivLog], { encoding: "utf8" }).stdout;
    expect(chown).toContain(`gateway:gateway -- ${mount}`);
    expect(chown).toContain(`gateway:gateway -- ${databasePath}`);
    expect(chown).toContain(`gateway:gateway -- ${databasePath}-wal`);
    expect(setpriv).toMatch(/--reuid=10001 --regid=10001 --init-groups -- true/);
  });
});

describe("entrypoint docker fixture", () => {
  it.skipIf(!dockerAvailable())("chowns the volume and runs the command as uid 10001", () => {
    const mount = mkdtempSync(join(tmpdir(), "amg-docker-"));
    writeFileSync(join(mount, "oauth.sqlite"), "");
    const image = "amg-entrypoint-fixture:test";
    const build = spawnSync("docker", ["build", "-t", image, "-f", FIXTURE_IMAGE, process.cwd()], {
      encoding: "utf8",
    });
    expect(build.stderr).toBeDefined();
    expect(build.status).toBe(0);
    const run = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--user",
        "0",
        "-e",
        "DATABASE_PATH=/data/oauth.sqlite",
        "-e",
        "RAILWAY_VOLUME_MOUNT_PATH=/data",
        "-v",
        `${mount}:/data`,
        image,
        "id",
        "-u",
      ],
      { encoding: "utf8" },
    );
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe("10001");
    expect(fileOwnership(join(mount, "oauth.sqlite"))).toBe("10001:10001");
  });
});
