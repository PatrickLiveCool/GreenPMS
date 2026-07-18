import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const restoreScript = fileURLToPath(new URL("../../scripts/restore.sh", import.meta.url));

async function fakeDockerEnvironment(targetExists: boolean) {
  const workdir = await mkdtemp(join(tmpdir(), "qintopia-restore-contract-"));
  const bin = join(workdir, "bin");
  const log = join(workdir, "docker.log");
  const backup = join(workdir, "backup.dump");
  await mkdir(bin);
  await writeFile(backup, "PGDMP-restore-contract");
  const docker = join(bin, "docker");
  await writeFile(docker, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *" -d postgres "*) printf '%s' "$FAKE_TARGET_EXISTS" ;;
  *"schema_migrations"*) printf '6' ;;
esac
`, { mode: 0o700 });
  await chmod(docker, 0o700);
  return {
    workdir,
    log,
    backup,
    env: {
      ...process.env,
      ALLOW_RESTORE: "true",
      FAKE_DOCKER_LOG: log,
      FAKE_TARGET_EXISTS: targetExists ? "1" : "",
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`
    }
  };
}

describe("restore script contract", () => {
  it("refuses an existing target without dropping or recreating it", async () => {
    const fixture = await fakeDockerEnvironment(true);
    try {
      await expect(execFileAsync("bash", [restoreScript, fixture.backup, "existing_target"], { env: fixture.env }))
        .rejects.toMatchObject({ code: 2 });
      const calls = await readFile(fixture.log, "utf8");
      expect(calls).toContain("psql");
      expect(calls).not.toContain("dropdb");
      expect(calls).not.toContain("createdb");
    } finally {
      await rm(fixture.workdir, { recursive: true, force: true });
    }
  });

  it("creates and restores only when the target name is new", async () => {
    const fixture = await fakeDockerEnvironment(false);
    try {
      await expect(execFileAsync("bash", [restoreScript, fixture.backup, "new_restore_target"], { env: fixture.env }))
        .resolves.toMatchObject({ stdout: expect.stringContaining("Restored") });
      const calls = await readFile(fixture.log, "utf8");
      expect(calls).toContain("createdb -U qintopia new_restore_target");
      expect(calls).toContain("pg_restore");
      expect(calls).not.toContain("dropdb");
    } finally {
      await rm(fixture.workdir, { recursive: true, force: true });
    }
  });
});
