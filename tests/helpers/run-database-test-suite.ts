import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";
import pg from "pg";
import {
  assertDatabaseTestRunnerPlatform,
  assertLockDatabaseIsNotResetTarget,
  resolveLockDatabaseUrl
} from "./database-test-lock-config.ts";

const defaultLockId = "qintopia-pms-database-backed-verification-v1";
const defaultTimeoutMs = 10 * 60_000;
const defaultPollMs = 100;
const defaultShutdownGraceMs = 5_000;
const defaultProcessSnapshotMs = 100;

type LockFailure = { source: "coordination" | "cleanup guard"; error: Error };
type ChildResult = { code: number | null; signal: NodeJS.Signals | null };
type LockRow = { acquired: boolean; backend_pid: number };
type LockQueryOutcome =
  | { kind: "result"; result: pg.QueryResult<LockRow> }
  | { kind: "error"; error: unknown }
  | { kind: "stopped"; reason: "abort" | "timeout" };
type RunnerFaults = {
  lockQueryDelayMs: number;
  groupProbeFailuresRemaining: number;
  processSnapshotFailuresRemaining: number;
};
type ProcessTableRow = { pid: number; parentPid: number; processGroupId: number };

function positiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function testFaultPositiveInteger(name: string): number {
  if (process.env.NODE_ENV !== "test") return 0;
  const value = process.env[name];
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer when set`);
  }
  return parsed;
}

function commandArguments(): { command: string; args: string[] } {
  const values = process.argv.slice(2);
  if (values[0] === "--") values.shift();
  const command = values.shift();
  if (!command) throw new Error("Usage: run-database-test-suite.ts -- <command> [arguments...]");
  return { command, args: values };
}

function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (osConstants.signals[signal] ?? 0);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function actualProcessGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

function processGroupExists(processGroupId: number, faults: RunnerFaults): boolean {
  if (faults.groupProbeFailuresRemaining > 0) {
    faults.groupProbeFailuresRemaining -= 1;
    throw new Error("injected child process group liveness failure");
  }
  return actualProcessGroupExists(processGroupId);
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function readProcessTableWithArguments(arguments_: string[]): Promise<ProcessTableRow[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "ps",
      arguments_,
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 2_000, killSignal: "SIGKILL" },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const rows = stdout.split("\n").flatMap((line): ProcessTableRow[] => {
          const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
          if (!match) return [];
          return [{
            pid: Number(match[1]),
            parentPid: Number(match[2]),
            processGroupId: Number(match[3])
          }];
        });
        if (rows.length === 0) reject(new Error("ps returned no parseable process rows"));
        else resolve(rows);
      }
    );
  });
}

async function readProcessTable(): Promise<ProcessTableRow[]> {
  try {
    return await readProcessTableWithArguments(["-axo", "pid=,ppid=,pgid="]);
  } catch (primaryError: unknown) {
    try {
      // BusyBox ps lists the container process table without -a/-x and rejects -axo.
      return await readProcessTableWithArguments(["-o", "pid=,ppid=,pgid="]);
    } catch (fallbackError: unknown) {
      throw new Error(
        `ps process snapshot failed (${errorMessage(primaryError)}); BusyBox fallback failed (${errorMessage(fallbackError)})`
      );
    }
  }
}

class DescendantProcessTracker {
  private activeProcessIds: Set<number>;
  private processGroupIds: Set<number>;
  private readonly loggedProcessGroupIds = new Set<number>();
  private snapshotInFlight: Promise<boolean> | undefined;
  private snapshotTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly rootProcessId: number,
    private readonly runnerProcessGroupId: number,
    private readonly snapshotIntervalMs: number,
    private readonly faults: RunnerFaults
  ) {
    this.activeProcessIds = new Set([rootProcessId]);
    this.processGroupIds = new Set([rootProcessId]);
  }

  start(): void {
    this.snapshotTimer = setInterval(() => { void this.snapshot(); }, this.snapshotIntervalMs);
    this.snapshotTimer.unref();
    void this.snapshot();
  }

  private safeProcessGroupId(processGroupId: number): boolean {
    return processGroupId > 1
      && processGroupId !== process.pid
      && processGroupId !== this.runnerProcessGroupId;
  }

  private async performSnapshot(): Promise<boolean> {
    try {
      if (this.faults.processSnapshotFailuresRemaining > 0) {
        this.faults.processSnapshotFailuresRemaining -= 1;
        throw new Error("injected process tree snapshot failure");
      }
      const rows = await readProcessTable();
      const byPid = new Map(rows.map((row) => [row.pid, row]));
      const childrenByParent = new Map<number, ProcessTableRow[]>();
      for (const row of rows) {
        const children = childrenByParent.get(row.parentPid) ?? [];
        children.push(row);
        childrenByParent.set(row.parentPid, children);
      }

      const nextActive = new Set<number>();
      const queue: number[] = [];
      for (const pid of this.activeProcessIds) {
        if (byPid.has(pid)) {
          nextActive.add(pid);
          queue.push(pid);
        }
      }
      if (byPid.has(this.rootProcessId) && !nextActive.has(this.rootProcessId)) {
        nextActive.add(this.rootProcessId);
        queue.push(this.rootProcessId);
      }
      for (let index = 0; index < queue.length; index += 1) {
        for (const child of childrenByParent.get(queue[index]!) ?? []) {
          if (nextActive.has(child.pid) || child.pid === process.pid) continue;
          nextActive.add(child.pid);
          queue.push(child.pid);
        }
      }

      const nextGroups = new Set<number>();
      for (const pid of nextActive) {
        const row = byPid.get(pid);
        if (!row || !this.safeProcessGroupId(row.processGroupId)) continue;
        nextGroups.add(row.processGroupId);
        if (row.processGroupId !== this.rootProcessId && !this.loggedProcessGroupIds.has(row.processGroupId)) {
          this.loggedProcessGroupIds.add(row.processGroupId);
          process.stdout.write(`[test-suite-lock] tracking descendant process group ${row.processGroupId}\n`);
        }
      }
      for (const processGroupId of this.processGroupIds) {
        if (nextGroups.has(processGroupId) || !this.safeProcessGroupId(processGroupId)) continue;
        try {
          if (actualProcessGroupExists(processGroupId)) nextGroups.add(processGroupId);
        } catch {
          // Unknown liveness retains the previously observed group until cleanup can prove it gone.
          nextGroups.add(processGroupId);
        }
      }
      this.activeProcessIds = nextActive;
      this.processGroupIds = nextGroups;
      return true;
    } catch (error: unknown) {
      process.stderr.write(`[test-suite-lock] process tree snapshot failed; retaining database fence: ${errorMessage(error)}\n`);
      return false;
    }
  }

  snapshot(): Promise<boolean> {
    if (this.snapshotInFlight) return this.snapshotInFlight;
    const snapshot = this.performSnapshot();
    this.snapshotInFlight = snapshot;
    void snapshot.finally(() => {
      if (this.snapshotInFlight === snapshot) this.snapshotInFlight = undefined;
    });
    return snapshot;
  }

  signalObservedGroups(signal: NodeJS.Signals): void {
    const groups = [...this.processGroupIds]
      .filter((processGroupId) => this.safeProcessGroupId(processGroupId))
      .sort((left, right) => {
        if (left === this.rootProcessId) return 1;
        if (right === this.rootProcessId) return -1;
        return left - right;
      });
    for (const processGroupId of groups) {
      try {
        signalProcessGroup(processGroupId, signal);
      } catch (error: unknown) {
        process.stderr.write(`[test-suite-lock] failed to signal descendant process group ${processGroupId}; retaining database fence: ${errorMessage(error)}\n`);
      }
    }
  }

  async snapshotAndSignal(signal: NodeJS.Signals): Promise<boolean> {
    if (!await this.snapshot()) return false;
    this.signalObservedGroups(signal);
    return true;
  }

  async allObservedGroupsGone(faults: RunnerFaults): Promise<boolean> {
    if (!await this.snapshot()) return false;
    for (const processGroupId of this.processGroupIds) {
      try {
        if (processGroupExists(processGroupId, faults)) return false;
      } catch (error: unknown) {
        process.stderr.write(`[test-suite-lock] descendant process group liveness check failed; retaining database fence: ${errorMessage(error)}\n`);
        return false;
      }
    }
    return true;
  }

  async stop(): Promise<void> {
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.snapshotTimer = undefined;
    if (this.snapshotInFlight) await this.snapshotInFlight;
  }
}

async function descendantGroupsGoneBefore(
  tracker: DescendantProcessTracker,
  deadline: number,
  faults: RunnerFaults
): Promise<boolean> {
  while (Date.now() < deadline) {
    if (await tracker.allObservedGroupsGone(faults)) return true;
    await delay(20);
  }
  return tracker.allObservedGroupsGone(faults);
}

async function terminateDescendantGroupsUntilGone(
  tracker: DescendantProcessTracker,
  initialSignal: NodeJS.Signals,
  graceMs: number,
  faults: RunnerFaults
): Promise<void> {
  let signal = initialSignal;
  let attempts = 0;
  while (true) {
    if (!await tracker.snapshotAndSignal(signal)) {
      await delay(20);
      continue;
    }
    if (await descendantGroupsGoneBefore(tracker, Date.now() + graceMs, faults)) return;
    attempts += 1;
    signal = "SIGKILL";
    if (attempts > 1) {
      process.stderr.write("[test-suite-lock] descendant process groups are still alive; retaining database fence and retrying SIGKILL\n");
    }
  }
}

async function boundedLockQuery(
  client: pg.Client,
  key: string,
  timeoutMs: number,
  signal: AbortSignal,
  queryDelayMs: number
): Promise<LockQueryOutcome> {
  if (signal.aborted) return { kind: "stopped", reason: "abort" };

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<LockQueryOutcome>((resolve) => {
    onAbort = () => resolve({ kind: "stopped", reason: "abort" });
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => resolve({ kind: "stopped", reason: "timeout" }), timeoutMs);
  });
  const queryText = queryDelayMs > 0
    ? "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired, pg_backend_pid() AS backend_pid FROM pg_sleep($2::double precision / 1000.0)"
    : "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired, pg_backend_pid() AS backend_pid";
  const queryValues: Array<string | number> = queryDelayMs > 0 ? [key, queryDelayMs] : [key];
  const queried: Promise<LockQueryOutcome> = client.query<LockRow>(
    queryText,
    queryValues
  ).then(
    (result): LockQueryOutcome => ({ kind: "result", result }),
    (error: unknown): LockQueryOutcome => ({ kind: "error", error })
  );

  try {
    return await Promise.race([queried, stopped]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function run(): Promise<number> {
  const { command, args } = commandArguments();
  assertDatabaseTestRunnerPlatform();
  const lockId = process.env.TEST_SUITE_LOCK_ID ?? defaultLockId;
  const timeoutMs = positiveInteger("TEST_SUITE_LOCK_TIMEOUT_MS", defaultTimeoutMs);
  const pollMs = positiveInteger("TEST_SUITE_LOCK_POLL_MS", defaultPollMs);
  const shutdownGraceMs = positiveInteger("TEST_SUITE_CHILD_SHUTDOWN_GRACE_MS", defaultShutdownGraceMs);
  const processSnapshotMs = positiveInteger("TEST_SUITE_PROCESS_SNAPSHOT_MS", defaultProcessSnapshotMs);
  const faults: RunnerFaults = {
    lockQueryDelayMs: testFaultPositiveInteger("TEST_SUITE_FAULT_LOCK_QUERY_DELAY_MS"),
    groupProbeFailuresRemaining: testFaultPositiveInteger("TEST_SUITE_FAULT_GROUP_PROBE_FAILURES"),
    processSnapshotFailuresRemaining: testFaultPositiveInteger("TEST_SUITE_FAULT_PROCESS_SNAPSHOT_FAILURES")
  };
  const lockDatabaseUrl = resolveLockDatabaseUrl();
  assertLockDatabaseIsNotResetTarget(lockDatabaseUrl);

  const coordinationClient = new pg.Client({
    connectionString: lockDatabaseUrl,
    connectionTimeoutMillis: Math.min(timeoutMs, 10_000),
    application_name: "qintopia-test-suite-lock"
  });
  const cleanupGuardClient = new pg.Client({
    connectionString: lockDatabaseUrl,
    connectionTimeoutMillis: Math.min(timeoutMs, 10_000),
    application_name: "qintopia-test-suite-cleanup-guard"
  });
  const abort = new AbortController();
  let closingClients = false;
  let coordinationAcquired = false;
  let cleanupGuardAcquired = false;
  let timedOut = false;
  let reportedWaiting = false;
  let lockFailure: LockFailure | undefined;
  let shutdownSignal: NodeJS.Signals | undefined;
  let child: ChildProcess | undefined;
  let descendantTracker: DescendantProcessTracker | undefined;
  let childResult: ChildResult | undefined;
  let groupShutdown: Promise<void> | undefined;
  const failedLockSources = new Set<LockFailure["source"]>();
  let receivedSignalCount = 0;
  let exitCode = 1;

  const requestGroupShutdown = (signal: NodeJS.Signals): Promise<void> => {
    if (!child || !descendantTracker) return Promise.resolve();
    if (!groupShutdown) {
      groupShutdown = terminateDescendantGroupsUntilGone(descendantTracker, signal, shutdownGraceMs, faults);
    }
    return groupShutdown;
  };
  const recordLockFailure = (source: LockFailure["source"], error: Error) => {
    if (closingClients) return;
    failedLockSources.add(source);
    if (lockFailure) {
      process.stderr.write(`[test-suite-lock] additional lock connection error (${source}): ${error.message}\n`);
      if (failedLockSources.size > 1 && descendantTracker) {
        process.stderr.write("[test-suite-lock] both lock connections failed; escalating observed descendant process groups immediately\n");
        void descendantTracker.snapshotAndSignal("SIGKILL");
      }
      return;
    }
    lockFailure = { source, error };
    process.stderr.write(`[test-suite-lock] fatal lock connection error (${source}): ${error.message}\n`);
    abort.abort();
    void requestGroupShutdown("SIGTERM");
  };
  const coordinationError = (error: Error) => recordLockFailure("coordination", error);
  const cleanupGuardError = (error: Error) => recordLockFailure("cleanup guard", error);
  coordinationClient.on("error", coordinationError);
  cleanupGuardClient.on("error", cleanupGuardError);

  const handleSignal = (signal: NodeJS.Signals) => {
    receivedSignalCount += 1;
    shutdownSignal ??= signal;
    abort.abort();
    if (receivedSignalCount > 1 && child && descendantTracker) {
      void descendantTracker.snapshotAndSignal("SIGKILL");
    } else {
      void requestGroupShutdown(signal);
    }
  };
  const onSigint = () => handleSignal("SIGINT");
  const onSigterm = () => handleSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  const deadline = Date.now() + timeoutMs;
  const acquire = async (client: pg.Client, key: string): Promise<number | undefined> => {
    while (!lockFailure && !shutdownSignal) {
      const remainingBeforeQuery = deadline - Date.now();
      if (remainingBeforeQuery <= 0) {
        timedOut = true;
        return undefined;
      }
      const outcome = await boundedLockQuery(
        client,
        key,
        remainingBeforeQuery,
        abort.signal,
        faults.lockQueryDelayMs
      );
      if (outcome.kind === "stopped") {
        if (outcome.reason === "timeout") timedOut = true;
        await client.end().catch(() => undefined);
        return undefined;
      }
      if (outcome.kind === "error") {
        if (!lockFailure) throw outcome.error;
        return undefined;
      }
      if (outcome.result.rows[0]?.acquired) return outcome.result.rows[0].backend_pid;
      if (!reportedWaiting) {
        process.stdout.write("[test-suite-lock] waiting for database-backed test suite lock\n");
        reportedWaiting = true;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        timedOut = true;
        return undefined;
      }
      await delay(Math.min(pollMs, remainingMs), abort.signal);
    }
    return undefined;
  };

  try {
    const runnerRow = (await readProcessTable()).find((row) => row.pid === process.pid);
    if (!runnerRow || runnerRow.processGroupId < 1) {
      throw new Error("Could not determine a safe runner process group from ps");
    }
    await cleanupGuardClient.connect();
    await coordinationClient.connect();
    const guardPid = await acquire(cleanupGuardClient, `${lockId}:cleanup-guard`);
    cleanupGuardAcquired = guardPid !== undefined;
    const backendPid = cleanupGuardAcquired ? await acquire(coordinationClient, lockId) : undefined;
    coordinationAcquired = backendPid !== undefined;

    if (timedOut) {
      process.stderr.write(`[test-suite-lock] timed out waiting for database-backed test suite lock after ${timeoutMs}ms\n`);
      exitCode = 75;
    } else if (lockFailure) {
      exitCode = 1;
    } else if (shutdownSignal) {
      exitCode = signalExitCode(shutdownSignal);
    } else if (!coordinationAcquired || !cleanupGuardAcquired || backendPid === undefined) {
      process.stderr.write("[test-suite-lock] failed to acquire both database-backed test suite locks\n");
      exitCode = 1;
    } else {
      process.stdout.write(`[test-suite-lock] acquired database-backed test suite lock; lock backend PID ${backendPid}; cleanup guard PID ${guardPid}\n`);
      childResult = await new Promise<ChildResult>((resolve, reject) => {
        child = spawn(command, args, {
          stdio: "inherit",
          env: { ...process.env, QINTOPIA_DATABASE_TEST_LOCK_HELD: "1" },
          detached: true
        });
        if (child.pid !== undefined) {
          descendantTracker = new DescendantProcessTracker(child.pid, runnerRow.processGroupId, processSnapshotMs, faults);
          descendantTracker.start();
        }
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
        if (lockFailure) void requestGroupShutdown("SIGTERM");
        else if (shutdownSignal) void requestGroupShutdown(shutdownSignal);
      });

      if (groupShutdown) await groupShutdown;
      if (lockFailure) exitCode = 1;
      else if (shutdownSignal) exitCode = signalExitCode(shutdownSignal);
      else if (childResult.code !== null) exitCode = childResult.code;
      else exitCode = childResult.signal ? signalExitCode(childResult.signal) : 1;
    }
  } catch (error: unknown) {
    if (!lockFailure) process.stderr.write(`[test-suite-lock] ${errorMessage(error)}\n`);
    exitCode = 1;
  } finally {
    abort.abort();

    if (child && descendantTracker) {
      if (groupShutdown) {
        await groupShutdown;
      } else {
        if (!await descendantTracker.allObservedGroupsGone(faults)) {
          process.stderr.write("[test-suite-lock] child leader exited while its process group remained alive or descendant process groups remained alive\n");
          exitCode = 1;
          await requestGroupShutdown(lockFailure ? "SIGTERM" : shutdownSignal ?? "SIGTERM");
        }
      }
      await descendantTracker.stop();
    }

    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    if (!lockFailure && shutdownSignal) exitCode = signalExitCode(shutdownSignal);

    closingClients = true;
    await coordinationClient.end().catch(() => undefined);
    await cleanupGuardClient.end().catch(() => undefined);
    coordinationClient.removeListener("error", coordinationError);
    cleanupGuardClient.removeListener("error", cleanupGuardError);
  }

  return exitCode;
}

void run()
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    process.stderr.write(`[test-suite-lock] ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
