import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { testDatabaseUrl } from "../helpers/database.ts";

const runnerPath = fileURLToPath(new URL("../helpers/run-database-test-suite.ts", import.meta.url));

type RunnerProcess = {
  child: ChildProcessWithoutNullStreams;
  output: () => string;
  completed: Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>;
};

function lockDatabaseUrl(): string {
  if (process.env.TEST_SUITE_LOCK_DATABASE_URL) return process.env.TEST_SUITE_LOCK_DATABASE_URL;
  const url = new URL(testDatabaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

function launchRunner(
  lockId: string,
  childSource: string,
  timeoutMs = 5_000,
  environment: Record<string, string> = {}
): RunnerProcess {
  let output = "";
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    runnerPath,
    "--",
    process.execPath,
    "-e",
    childSource
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TEST_SUITE_LOCK_DATABASE_URL: lockDatabaseUrl(),
      TEST_SUITE_LOCK_ID: lockId,
      TEST_SUITE_LOCK_TIMEOUT_MS: String(timeoutMs),
      TEST_SUITE_LOCK_POLL_MS: "20",
      ...environment
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal, output }));
  });
  return { child, output: () => output, completed };
}

async function waitForOutput(process: RunnerProcess, marker: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (process.output().includes(marker)) return;
    if (process.child.exitCode !== null || process.child.signalCode !== null) {
      throw new Error(`Runner exited before ${JSON.stringify(marker)}:\n${process.output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(marker)}:\n${process.output()}`);
}

function interval(output: string, label: string): { start: number; end: number } {
  const start = new RegExp(`CHILD_START ${label} (\\d+)`).exec(output)?.[1];
  const end = new RegExp(`CHILD_END ${label} (\\d+)`).exec(output)?.[1];
  if (!start || !end) throw new Error(`Missing ${label} interval:\n${output}`);
  return { start: Number(start), end: Number(end) };
}

function expectProcessGone(pid: number): void {
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
}

function detachedTreeSource(prefix: string, rootExitDelayMs?: number, descendantExitDelayMs?: number): string {
  const descendantLifetime = descendantExitDelayMs === undefined
    ? "setInterval(() => {}, 10_000);"
    : `setTimeout(() => process.exit(0), ${descendantExitDelayMs});`;
  const levelTwoSource = `
    process.on("SIGTERM", () => {});
    process.stdout.write(${JSON.stringify(`${prefix}_LEVEL_TWO_READY `)} + process.pid + "\\n");
    ${descendantLifetime}
  `;
  const levelOneSource = `
    const { spawn } = require("node:child_process");
    const levelTwo = spawn(process.execPath, ["-e", ${JSON.stringify(levelTwoSource)}], {
      detached: true,
      stdio: ["ignore", "inherit", "inherit"]
    });
    process.on("SIGTERM", () => {});
    process.stdout.write(${JSON.stringify(`${prefix}_LEVEL_ONE_READY `)} + process.pid + " " + levelTwo.pid + "\\n");
    ${descendantLifetime}
  `;
  return `
    const { spawn } = require("node:child_process");
    const levelOne = spawn(process.execPath, ["-e", ${JSON.stringify(levelOneSource)}], {
      detached: true,
      stdio: ["ignore", "inherit", "inherit"]
    });
    process.stdout.write(${JSON.stringify(`${prefix}_ROOT_READY `)} + process.pid + " " + levelOne.pid + "\\n");
    ${rootExitDelayMs === undefined
      ? "setInterval(() => {}, 10_000);"
      : `setTimeout(() => process.exit(0), ${rootExitDelayMs});`}
  `;
}

function detachedTreePids(output: string, prefix: string): { levelOne: number; levelTwo: number } {
  const levelOne = Number(new RegExp(`${prefix}_LEVEL_ONE_READY (\\d+)`).exec(output)?.[1]);
  const levelTwo = Number(new RegExp(`${prefix}_LEVEL_TWO_READY (\\d+)`).exec(output)?.[1]);
  if (levelOne <= 0 || levelTwo <= 0) throw new Error(`Missing detached tree PIDs:\n${output}`);
  return { levelOne, levelTwo };
}

describe("database-backed test suite runner", () => {
  it("serializes independent invocations before either child command can touch a fixed test database", async () => {
    const lockId = `runner-serialization-${process.pid}-${Date.now()}`;
    const childSource = (label: string) => `
      const label = ${JSON.stringify(label)};
      process.stdout.write(\`CHILD_START \${label} \${Date.now()}\\n\`);
      setTimeout(() => {
        process.stdout.write(\`CHILD_END \${label} \${Date.now()}\\n\`);
      }, 350);
    `;
    const first = launchRunner(lockId, childSource("first"));
    const second = launchRunner(lockId, childSource("second"));
    const [firstResult, secondResult] = await Promise.all([first.completed, second.completed]);

    expect(firstResult.code, firstResult.output).toBe(0);
    expect(secondResult.code, secondResult.output).toBe(0);
    const firstInterval = interval(firstResult.output, "first");
    const secondInterval = interval(secondResult.output, "second");
    expect(
      firstInterval.end <= secondInterval.start || secondInterval.end <= firstInterval.start,
      `Child commands overlapped:\n${firstResult.output}\n${secondResult.output}`
    ).toBe(true);
    expect(`${firstResult.output}\n${secondResult.output}`).toContain("waiting for database-backed test suite lock");
  });

  it("times out without starting the waiting child command", async () => {
    const lockId = `runner-timeout-${process.pid}-${Date.now()}`;
    const holder = launchRunner(lockId, "setTimeout(() => {}, 1_000);");
    await waitForOutput(holder, "acquired database-backed test suite lock");

    const waiter = launchRunner(lockId, "process.stdout.write('WAITED_CHILD_STARTED\\n');", 100);
    const waiterResult = await waiter.completed;
    const holderResult = await holder.completed;

    expect(holderResult.code, holderResult.output).toBe(0);
    expect(waiterResult.code, waiterResult.output).toBe(75);
    expect(waiterResult.signal, waiterResult.output).toBeNull();
    expect(waiterResult.output).toContain("timed out waiting for database-backed test suite lock");
    expect(waiterResult.output).not.toContain("WAITED_CHILD_STARTED");
  });

  it("destroys a pending lock query when the acquisition deadline expires", async () => {
    const startedAt = Date.now();
    const runner = launchRunner(
      `runner-query-timeout-${process.pid}-${Date.now()}`,
      "process.stdout.write('DELAYED_QUERY_CHILD_STARTED\\n');",
      150,
      {
        NODE_ENV: "test",
        TEST_SUITE_FAULT_LOCK_QUERY_DELAY_MS: "5000"
      }
    );
    const result = await runner.completed;

    expect(result.code, result.output).toBe(75);
    expect(result.signal, result.output).toBeNull();
    expect(Date.now() - startedAt, result.output).toBeLessThan(2_000);
    expect(result.output).toContain("timed out waiting for database-backed test suite lock");
    expect(result.output).not.toContain("DELAYED_QUERY_CHILD_STARTED");
  });

  it("releases the session lock after SIGTERM so a successor does not inherit stale state", async () => {
    const lockId = `runner-signal-${process.pid}-${Date.now()}`;
    const holder = launchRunner(lockId, `
      process.stdout.write("SIGNAL_CHILD_READY " + process.pid + "\\n");
      setInterval(() => {}, 10_000);
    `);
    await waitForOutput(holder, "SIGNAL_CHILD_READY");
    const childPid = Number(/SIGNAL_CHILD_READY (\d+)/.exec(holder.output())?.[1]);
    expect(childPid, holder.output()).toBeGreaterThan(0);
    holder.child.kill("SIGTERM");
    const holderResult = await holder.completed;

    expect(holderResult.code, holderResult.output).toBe(143);
    expect(holderResult.signal, holderResult.output).toBeNull();
    expectProcessGone(childPid);
    const successor = launchRunner(lockId, "process.stdout.write('SUCCESSOR_STARTED\\n');", 1_000);
    const successorResult = await successor.completed;
    expect(successorResult.code, successorResult.output).toBe(0);
    expect(successorResult.output).toContain("SUCCESSOR_STARTED");
  });

  it("terminates two levels of detached descendant groups before releasing the guard on SIGTERM", async () => {
    const lockId = `runner-detached-signal-${process.pid}-${Date.now()}`;
    const prefix = "DETACHED_SIGNAL";
    const holder = launchRunner(lockId, detachedTreeSource(prefix), 5_000, {
      TEST_SUITE_CHILD_SHUTDOWN_GRACE_MS: "150",
      TEST_SUITE_PROCESS_SNAPSHOT_MS: "20"
    });
    await waitForOutput(holder, `${prefix}_LEVEL_TWO_READY`);
    const pids = detachedTreePids(holder.output(), prefix);
    await waitForOutput(holder, `tracking descendant process group ${pids.levelOne}`);
    await waitForOutput(holder, `tracking descendant process group ${pids.levelTwo}`);

    const successor = launchRunner(lockId, `
      const pids = ${JSON.stringify([pids.levelOne, pids.levelTwo])};
      for (const pid of pids) {
        try {
          process.kill(pid, 0);
          process.stderr.write("DETACHED_SIGNAL_SUCCESSOR_OVERLAP " + pid + "\\n");
          process.exit(21);
        } catch (error) {
          if (error && error.code !== "ESRCH") throw error;
        }
      }
      process.stdout.write("DETACHED_SIGNAL_SUCCESSOR_AFTER_CLEANUP\\n");
    `);
    await waitForOutput(successor, "waiting for database-backed test suite lock");

    holder.child.kill("SIGTERM");
    const [holderResult, successorResult] = await Promise.all([holder.completed, successor.completed]);
    expect(holderResult.code, holderResult.output).toBe(143);
    expect(holderResult.signal, holderResult.output).toBeNull();
    expectProcessGone(pids.levelOne);
    expectProcessGone(pids.levelTwo);
    expect(successorResult.code, successorResult.output).toBe(0);
    expect(successorResult.output).toContain("DETACHED_SIGNAL_SUCCESSOR_AFTER_CLEANUP");
    expect(successorResult.output).not.toContain("DETACHED_SIGNAL_SUCCESSOR_OVERLAP");
  });

  it("retains the fence when a cleanup snapshot fails before detached groups have been observed", async () => {
    const lockId = `runner-snapshot-failure-${process.pid}-${Date.now()}`;
    const prefix = "SNAPSHOT_FAILURE";
    const holder = launchRunner(lockId, detachedTreeSource(prefix, undefined, 1_500), 5_000, {
      NODE_ENV: "test",
      TEST_SUITE_CHILD_SHUTDOWN_GRACE_MS: "100",
      TEST_SUITE_PROCESS_SNAPSHOT_MS: "10000",
      TEST_SUITE_FAULT_PROCESS_SNAPSHOT_FAILURES: "2"
    });
    await waitForOutput(holder, `${prefix}_LEVEL_TWO_READY`);
    const pids = detachedTreePids(holder.output(), prefix);

    const successor = launchRunner(lockId, `
      const pids = ${JSON.stringify([pids.levelOne, pids.levelTwo])};
      for (const pid of pids) {
        try {
          process.kill(pid, 0);
          process.stderr.write("SNAPSHOT_FAILURE_SUCCESSOR_OVERLAP " + pid + "\\n");
          process.exit(23);
        } catch (error) {
          if (error && error.code !== "ESRCH") throw error;
        }
      }
      process.stdout.write("SNAPSHOT_FAILURE_SUCCESSOR_AFTER_CLEANUP\\n");
    `);
    await waitForOutput(successor, "waiting for database-backed test suite lock");

    holder.child.kill("SIGTERM");
    const [holderResult, successorResult] = await Promise.all([holder.completed, successor.completed]);
    expect(holderResult.code, holderResult.output).toBe(143);
    expect(holderResult.output).toContain("process tree snapshot failed; retaining database fence");
    expect(holderResult.output).toContain(`tracking descendant process group ${pids.levelOne}`);
    expect(holderResult.output).toContain(`tracking descendant process group ${pids.levelTwo}`);
    expectProcessGone(pids.levelOne);
    expectProcessGone(pids.levelTwo);
    expect(successorResult.code, successorResult.output).toBe(0);
    expect(successorResult.output).toContain("SNAPSHOT_FAILURE_SUCCESSOR_AFTER_CLEANUP");
    expect(successorResult.output).not.toContain("SNAPSHOT_FAILURE_SUCCESSOR_OVERLAP");
  });

  it("cleans detached descendant groups after the root leader exits normally before releasing the guard", async () => {
    const lockId = `runner-detached-leader-exit-${process.pid}-${Date.now()}`;
    const prefix = "DETACHED_EXIT";
    const holder = launchRunner(lockId, detachedTreeSource(prefix, 1_500), 5_000, {
      TEST_SUITE_CHILD_SHUTDOWN_GRACE_MS: "150",
      TEST_SUITE_PROCESS_SNAPSHOT_MS: "20"
    });
    await waitForOutput(holder, `${prefix}_LEVEL_TWO_READY`);
    const pids = detachedTreePids(holder.output(), prefix);
    await waitForOutput(holder, `tracking descendant process group ${pids.levelOne}`);
    await waitForOutput(holder, `tracking descendant process group ${pids.levelTwo}`);

    const successor = launchRunner(lockId, `
      const pids = ${JSON.stringify([pids.levelOne, pids.levelTwo])};
      for (const pid of pids) {
        try {
          process.kill(pid, 0);
          process.stderr.write("DETACHED_EXIT_SUCCESSOR_OVERLAP " + pid + "\\n");
          process.exit(22);
        } catch (error) {
          if (error && error.code !== "ESRCH") throw error;
        }
      }
      process.stdout.write("DETACHED_EXIT_SUCCESSOR_AFTER_CLEANUP\\n");
    `);
    await waitForOutput(successor, "waiting for database-backed test suite lock");

    const [holderResult, successorResult] = await Promise.all([holder.completed, successor.completed]);
    expect(holderResult.code, holderResult.output).toBe(1);
    expect(holderResult.signal, holderResult.output).toBeNull();
    expect(holderResult.output).toContain("descendant process groups remained alive");
    expectProcessGone(pids.levelOne);
    expectProcessGone(pids.levelTwo);
    expect(successorResult.code, successorResult.output).toBe(0);
    expect(successorResult.output).toContain("DETACHED_EXIT_SUCCESSOR_AFTER_CLEANUP");
    expect(successorResult.output).not.toContain("DETACHED_EXIT_SUCCESSOR_OVERLAP");
  });

  it("keeps signal handlers installed and escalates the complete process group on a second signal", async () => {
    const lockId = `runner-double-signal-${process.pid}-${Date.now()}`;
    const descendantSource = `
      process.on("SIGTERM", () => {});
      process.stdout.write("DOUBLE_SIGNAL_DESCENDANT_READY " + process.pid + "\\n");
      setTimeout(() => process.exit(0), 5_000);
    `;
    const holder = launchRunner(lockId, `
      const { spawn } = require("node:child_process");
      const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], {
        stdio: ["ignore", "inherit", "inherit"]
      });
      process.on("SIGTERM", () => {});
      process.stdout.write("DOUBLE_SIGNAL_LEADER_READY " + process.pid + " " + descendant.pid + "\\n");
      setTimeout(() => process.exit(0), 5_000);
    `, 5_000, { TEST_SUITE_CHILD_SHUTDOWN_GRACE_MS: "1000" });
    await waitForOutput(holder, "DOUBLE_SIGNAL_DESCENDANT_READY");
    const descendantPid = /DOUBLE_SIGNAL_DESCENDANT_READY (\d+)/.exec(holder.output())?.[1];
    expect(descendantPid, holder.output()).toBeTruthy();

    holder.child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 30));
    holder.child.kill("SIGTERM");
    const result = await holder.completed;

    expect(result.code, result.output).toBe(143);
    expect(result.signal, result.output).toBeNull();
    expectProcessGone(Number(descendantPid));
    const successor = launchRunner(lockId, "process.stdout.write('DOUBLE_SIGNAL_SUCCESSOR_STARTED\\n');", 1_000);
    const successorResult = await successor.completed;
    expect(successorResult.code, successorResult.output).toBe(0);
    expect(successorResult.output).toContain("DOUBLE_SIGNAL_SUCCESSOR_STARTED");
  });

  it("fences successors until the complete child process group is gone after the lock backend dies", async () => {
    const lockId = `runner-backend-loss-${process.pid}-${Date.now()}`;
    const descendantSource = `
      process.on("SIGTERM", () => {});
      process.stdout.write("DESCENDANT_READY " + process.pid + "\\n");
      setTimeout(() => process.exit(0), 5_000);
    `;
    const holder = launchRunner(lockId, `
      const { spawn } = require("node:child_process");
      const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], {
        stdio: ["ignore", "inherit", "inherit"]
      });
      process.stdout.write("LEADER_STARTED " + process.pid + " " + descendant.pid + "\\n");
      process.on("SIGTERM", () => {
        process.stdout.write("LEADER_STOPPED " + Date.now() + "\\n");
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 5_000);
    `, 5_000, { TEST_SUITE_CHILD_SHUTDOWN_GRACE_MS: "150" });
    await waitForOutput(holder, "DESCENDANT_READY");
    const backendPid = /lock backend PID (\d+)/.exec(holder.output())?.[1];
    const descendantPid = /DESCENDANT_READY (\d+)/.exec(holder.output())?.[1];
    expect(backendPid, holder.output()).toBeTruthy();
    expect(descendantPid, holder.output()).toBeTruthy();

    const successor = launchRunner(lockId, `
      const descendantPid = ${Number(descendantPid)};
      try {
        process.kill(descendantPid, 0);
        process.stderr.write("SUCCESSOR_OVERLAP\\n");
        process.exit(17);
      } catch (error) {
        if (error && error.code !== "ESRCH") throw error;
      }
      process.stdout.write("SUCCESSOR_STARTED_AFTER_GROUP_EXIT\\n");
    `);
    await waitForOutput(successor, "waiting for database-backed test suite lock");

    const admin = new pg.Client({ connectionString: lockDatabaseUrl() });
    await admin.connect();
    try {
      const terminated = await admin.query<{ terminated: boolean }>(
        "SELECT pg_terminate_backend($1) AS terminated",
        [Number(backendPid)]
      );
      expect(terminated.rows[0]?.terminated).toBe(true);
    } finally {
      await admin.end();
    }

    const [holderResult, successorResult] = await Promise.all([holder.completed, successor.completed]);
    expect(holderResult.code, holderResult.output).toBe(1);
    expect(holderResult.signal, holderResult.output).toBeNull();
    expect(holderResult.output).toContain("fatal lock connection error");
    expect(holderResult.output).toContain("LEADER_STOPPED");
    expect(successorResult.code, successorResult.output).toBe(0);
    expect(successorResult.output).toContain("SUCCESSOR_STARTED_AFTER_GROUP_EXIT");
    expect(successorResult.output).not.toContain("SUCCESSOR_OVERLAP");
    expectProcessGone(Number(descendantPid));
  });

  it("keeps signal handling active while finally removes a lingering process group", async () => {
    const lockId = `runner-finally-signal-${process.pid}-${Date.now()}`;
    const descendantSource = `
      process.on("SIGTERM", () => {});
      process.stdout.write("FINALLY_DESCENDANT_READY " + process.pid + "\\n");
      setTimeout(() => process.exit(0), 5_000);
    `;
    const holder = launchRunner(lockId, `
      const { spawn } = require("node:child_process");
      const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], {
        stdio: ["ignore", "inherit", "inherit"]
      });
      process.stdout.write("FINALLY_LEADER_READY " + process.pid + " " + descendant.pid + "\\n");
      setTimeout(() => process.exit(0), 50);
    `, 5_000, { TEST_SUITE_CHILD_SHUTDOWN_GRACE_MS: "500" });
    await waitForOutput(holder, "FINALLY_DESCENDANT_READY");
    const descendantPid = Number(/FINALLY_DESCENDANT_READY (\d+)/.exec(holder.output())?.[1]);
    expect(descendantPid, holder.output()).toBeGreaterThan(0);
    await waitForOutput(holder, "child leader exited while its process group remained alive");

    holder.child.kill("SIGTERM");
    const result = await holder.completed;
    expect(result.code, result.output).toBe(143);
    expect(result.signal, result.output).toBeNull();
    expectProcessGone(descendantPid);
  });

  it("retains the surviving guard while process-group liveness is temporarily unprovable", async () => {
    const lockId = `runner-probe-failure-${process.pid}-${Date.now()}`;
    const descendantSource = `
      process.on("SIGTERM", () => {});
      process.stdout.write("PROBE_DESCENDANT_READY " + process.pid + "\\n");
      setTimeout(() => process.exit(0), 5_000);
    `;
    const holder = launchRunner(lockId, `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], {
        stdio: ["ignore", "inherit", "inherit"]
      });
      process.stdout.write("PROBE_LEADER_READY " + process.pid + "\\n");
      process.stdin.resume();
      process.stdin.once("data", () => process.exit(0));
    `, 5_000, {
      NODE_ENV: "test",
      TEST_SUITE_CHILD_SHUTDOWN_GRACE_MS: "100",
      TEST_SUITE_FAULT_GROUP_PROBE_FAILURES: "2"
    });
    await waitForOutput(holder, "PROBE_DESCENDANT_READY");
    const descendantPid = Number(/PROBE_DESCENDANT_READY (\d+)/.exec(holder.output())?.[1]);
    expect(descendantPid, holder.output()).toBeGreaterThan(0);

    const successor = launchRunner(lockId, `
      const descendantPid = ${descendantPid};
      try {
        process.kill(descendantPid, 0);
        process.stderr.write("PROBE_SUCCESSOR_OVERLAP\\n");
        process.exit(19);
      } catch (error) {
        if (error && error.code !== "ESRCH") throw error;
      }
      process.stdout.write("PROBE_SUCCESSOR_AFTER_CLEANUP\\n");
    `);
    await waitForOutput(successor, "waiting for database-backed test suite lock");
    holder.child.stdin.write("release\n");

    const [holderResult, successorResult] = await Promise.all([holder.completed, successor.completed]);
    expect(holderResult.code, holderResult.output).toBe(1);
    expect(holderResult.output).toContain("liveness check failed; retaining database fence");
    expect(successorResult.code, successorResult.output).toBe(0);
    expect(successorResult.output).toContain("PROBE_SUCCESSOR_AFTER_CLEANUP");
    expect(successorResult.output).not.toContain("PROBE_SUCCESSOR_OVERLAP");
    expectProcessGone(descendantPid);
  });

  it("escalates immediately when both lock sessions are lost", async () => {
    const lockId = `runner-double-backend-loss-${process.pid}-${Date.now()}`;
    const descendantSource = `
      process.on("SIGTERM", () => {});
      process.stdout.write("DOUBLE_LOSS_DESCENDANT_READY " + process.pid + "\\n");
      setTimeout(() => process.exit(0), 10_000);
    `;
    const holder = launchRunner(lockId, `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], {
        stdio: ["ignore", "inherit", "inherit"]
      });
      process.on("SIGTERM", () => {});
      process.stdout.write("DOUBLE_LOSS_LEADER_READY " + process.pid + "\\n");
      setTimeout(() => process.exit(0), 10_000);
    `, 5_000, { TEST_SUITE_CHILD_SHUTDOWN_GRACE_MS: "5000" });
    await waitForOutput(holder, "DOUBLE_LOSS_DESCENDANT_READY");
    const match = /lock backend PID (\d+); cleanup guard PID (\d+)/.exec(holder.output());
    const descendantPid = Number(/DOUBLE_LOSS_DESCENDANT_READY (\d+)/.exec(holder.output())?.[1]);
    expect(match, holder.output()).toBeTruthy();
    expect(descendantPid, holder.output()).toBeGreaterThan(0);

    const admin = new pg.Client({ connectionString: lockDatabaseUrl() });
    await admin.connect();
    const startedAt = Date.now();
    try {
      const terminated = await admin.query<{ terminated: boolean }>(
        "SELECT pg_terminate_backend(pid) AS terminated FROM unnest($1::int[]) AS pid",
        [[Number(match?.[1]), Number(match?.[2])]]
      );
      expect(terminated.rows.every((row) => row.terminated)).toBe(true);
    } finally {
      await admin.end();
    }

    const result = await holder.completed;
    expect(result.code, result.output).toBe(1);
    expect(result.signal, result.output).toBeNull();
    expect(Date.now() - startedAt, result.output).toBeLessThan(2_500);
    expect(result.output).toContain("additional lock connection error");
    expectProcessGone(descendantPid);
  });

  it("rejects a lock database that is also a configured reset target before starting the child", async () => {
    const child = launchRunner(
      `runner-reset-conflict-${process.pid}-${Date.now()}`,
      "process.stdout.write('CONFLICT_CHILD_STARTED\\n');",
      1_000,
      { TEST_SUITE_LOCK_DATABASE_URL: testDatabaseUrl }
    );
    const result = await child.completed;
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain("is also a database reset target");
    expect(result.output).not.toContain("CONFLICT_CHILD_STARTED");
  });
});
