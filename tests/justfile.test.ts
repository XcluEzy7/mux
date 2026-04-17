import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const tempDirs: string[] = [];

function runJust(args: string[], env: Record<string, string>): string {
  return execFileSync("just", args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function waitFor(fn: () => boolean, timeoutMs = 5_000): void {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fn()) {
      return;
    }
    Bun.sleepSync(100);
  }

  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("justfile dev server lifecycle", () => {
  test("start/status/stop manage a background dev server process", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-justfile-"));
    tempDirs.push(tempDir);

    const pidFile = path.join(tempDir, "dev-server.pid");
    const logFile = path.join(tempDir, "dev-server.log");
    const env = {
      DEV_SERVER_PID_FILE: pidFile,
      DEV_SERVER_LOG_FILE: logFile,
      DEV_SERVER_STARTUP_WAIT_SECS: "0.2",
      DEV_SERVER_CMD:
        "node -e 'console.log(\"justfile-test-ready\"); setInterval(() => {}, 1000)'",
    };

    const startOutput = runJust(["start"], env);
    expect(startOutput).toContain("Started dev server in background");

    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    expect(Number.isFinite(pid)).toBe(true);
    waitFor(() => fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes("justfile-test-ready"));
    expect(isAlive(pid)).toBe(true);

    const statusOutput = runJust(["status"], env);
    expect(statusOutput).toContain(`Dev server is running (pid ${pid})`);

    const stopOutput = runJust(["stop"], env);
    expect(stopOutput).toContain(`Stopped dev server (pid ${pid})`);
    waitFor(() => !isAlive(pid));
    expect(fs.existsSync(pidFile)).toBe(false);
  });
});
