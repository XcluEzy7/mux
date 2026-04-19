import * as os from "node:os";
import * as path from "node:path";
import * as fsPromises from "node:fs/promises";
import { afterEach, describe, expect, it } from "bun:test";
import { ensureTailscaleSshConfig } from "./tailscaleSshConfigWriter";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map(async (tempDir) => {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    })
  );
});

async function createTempSshConfigPath(): Promise<string> {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-tailscale-ssh-test-"));
  tempPaths.push(tempDir);
  return path.join(tempDir, ".ssh", "config");
}

describe("ensureTailscaleSshConfig", () => {
  it("uses explicit username when provided", async () => {
    const sshConfigPath = await createTempSshConfigPath();

    await ensureTailscaleSshConfig({
      sshHost: "my-machine.tailnet.ts.net",
      username: "alice",
      sshConfigPath,
    });

    const content = await fsPromises.readFile(sshConfigPath, "utf8");
    expect(content).toContain("User alice");
  });

  it("falls back to OS username when username is whitespace", async () => {
    const sshConfigPath = await createTempSshConfigPath();

    await ensureTailscaleSshConfig({
      sshHost: "my-machine.tailnet.ts.net",
      username: "    ",
      sshConfigPath,
    });

    const content = await fsPromises.readFile(sshConfigPath, "utf8");
    expect(content).toContain(`User ${os.userInfo().username}`);
  });
});
