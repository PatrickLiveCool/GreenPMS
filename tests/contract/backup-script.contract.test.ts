import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const backupScript = fileURLToPath(new URL("../../scripts/backup.sh", import.meta.url));

describe("backup script contract", () => {
  it("creates a private complete dump without leaving a partial file", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "qintopia-backup-contract-"));
    try {
      const bin = join(workdir, "bin");
      const output = join(workdir, "private", "backup.dump");
      await mkdir(bin);
      const fakeDocker = join(bin, "docker");
      await writeFile(fakeDocker, "#!/bin/sh\nprintf 'PGDMP-private-contract'\n", { mode: 0o700 });
      await chmod(fakeDocker, 0o700);

      await execFileAsync("bash", [backupScript, output], {
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` }
      });

      expect((await stat(output)).mode & 0o777).toBe(0o600);
      expect((await stat(join(workdir, "private"))).mode & 0o777).toBe(0o700);
      expect(await readdir(join(workdir, "private"))).toEqual(["backup.dump"]);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });
});
