import type { TestEnvironment } from "../setup";
import { cleanupTestEnvironment, createTestEnvironment } from "../setup";

describe("server.setTailscaleSsh", () => {
  let env: TestEnvironment;

  beforeAll(async () => {
    env = await createTestEnvironment();
  });

  afterAll(async () => {
    if (env) {
      await cleanupTestEnvironment(env);
    }
  });

  it("persists username and preserves host/proxy settings", async () => {
    await env.orpc.server.setTailscaleSsh({
      config: {
        enabled: true,
        sshHost: "my-machine.tailnet.ts.net",
        username: "alice",
        proxyCommand: false,
      },
    });

    const loaded = env.config.loadConfigOrDefault().tailscaleSsh;
    expect(loaded).toEqual({
      enabled: true,
      sshHost: "my-machine.tailnet.ts.net",
      username: "alice",
      proxyCommand: false,
    });

    const remote = await env.orpc.server.getTailscaleSsh();
    expect(remote).toEqual({
      enabled: true,
      sshHost: "my-machine.tailnet.ts.net",
      username: "alice",
      proxyCommand: false,
    });
  });

  it("normalizes whitespace-only usernames to undefined", async () => {
    await env.orpc.server.setTailscaleSsh({
      config: {
        enabled: true,
        sshHost: "my-machine.tailnet.ts.net",
        username: "   ",
        proxyCommand: true,
      },
    });

    const loaded = env.config.loadConfigOrDefault().tailscaleSsh;
    expect(loaded).toEqual({
      enabled: true,
      sshHost: "my-machine.tailnet.ts.net",
      username: undefined,
      proxyCommand: true,
    });

    const remote = await env.orpc.server.getTailscaleSsh();
    expect(remote).toEqual({
      enabled: true,
      sshHost: "my-machine.tailnet.ts.net",
      username: undefined,
      proxyCommand: true,
    });
  });
});
