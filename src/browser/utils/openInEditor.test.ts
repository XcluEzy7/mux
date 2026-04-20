import { describe, expect, test } from "bun:test";
import type { APIClient } from "@/browser/contexts/API";
import { openInEditor } from "./openInEditor";
import type { RuntimeConfig } from "@/common/types/runtime";
import { getExperimentKey, EXPERIMENT_IDS } from "@/common/constants/experiments";

interface GlobalWithOptionalWindow {
  window?: unknown;
}

async function withWindow<T>(windowValue: unknown, fn: () => Promise<T> | T): Promise<T> {
  const globalWithWindow = globalThis as unknown as GlobalWithOptionalWindow;
  const hadWindow = Object.prototype.hasOwnProperty.call(globalWithWindow, "window");
  const prevWindow = globalWithWindow.window;

  try {
    globalWithWindow.window = windowValue;
    return await fn();
  } finally {
    if (!hadWindow) {
      delete globalWithWindow.window;
    } else {
      globalWithWindow.window = prevWindow;
    }
  }
}

async function withNodeEnv<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env.NODE_ENV;
  if (value === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = value;
  }

  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previous;
    }
  }
}

describe("openInEditor", () => {
  const workspaceId = "ws-123";
  const filePath = "/home/user/project/plan.md";
  const parentDir = "/home/user/project";

  type OpenCall = [url: string, target?: string];

  function createMockWindow(
    calls: OpenCall[],
    options: {
      hostname?: string;
      editorConfig?: { editor: string };
      experiments?: Record<string, boolean>;
    } = {}
  ) {
    return {
      localStorage: {
        getItem: (key: string) => {
          if (key === "editorConfig" && options.editorConfig) {
            return JSON.stringify(options.editorConfig);
          }
          if (key in (options.experiments ?? {})) {
            return JSON.stringify(options.experiments?.[key]);
          }
          return null;
        },
      },
      location: { hostname: options.hostname ?? "localhost" },
      open: (url: string, target?: string) => {
        calls.push([url, target]);
        return null;
      },
    };
  }

  test("opens SSH file deep link (does not fall back to parent dir)", async () => {
    const calls: OpenCall[] = [];

    const runtimeConfig: RuntimeConfig = {
      type: "ssh",
      host: "devbox",
      srcBaseDir: "~/mux",
    };

    const result = await withWindow(createMockWindow(calls), () =>
      openInEditor({
        api: null,
        workspaceId,
        targetPath: filePath,
        runtimeConfig,
        isFile: true,
      })
    );

    expect(result.success).toBe(true);
    expect(calls.length).toBe(1);

    const [url, target] = calls[0];
    expect(target).toBe("_blank");
    expect(url.includes("ssh-remote+devbox")).toBe(true);
    expect(url.endsWith(`${filePath}:1:1`)).toBe(true);
  });

  test("opens devcontainer deep links with mapped container path", async () => {
    const calls: OpenCall[] = [];

    const runtimeConfig: RuntimeConfig = {
      type: "devcontainer",
      configPath: ".devcontainer/devcontainer.json",
    };

    const api = {
      workspace: {
        getDevcontainerInfo: () =>
          Promise.resolve({
            containerName: "jovial_newton",
            containerWorkspacePath: "/workspaces/myapp",
            hostWorkspacePath: "/Users/me/projects/myapp",
          }),
      },
    } as unknown as APIClient;

    const result = await withWindow(createMockWindow(calls), () =>
      openInEditor({
        api,
        workspaceId,
        targetPath: "/Users/me/projects/myapp/src/app.ts",
        runtimeConfig,
        isFile: true,
      })
    );

    expect(result.success).toBe(true);
    expect(calls.length).toBe(1);

    const [url, target] = calls[0];
    expect(target).toBe("_blank");
    expect(url).toMatch(/dev-container\+[0-9a-f]+\/workspaces\/myapp\/src$/);
  });

  test("opens Docker deep links at parent dir when targetPath is a file", async () => {
    const calls: OpenCall[] = [];

    const runtimeConfig: RuntimeConfig = {
      type: "docker",
      image: "node:20",
      containerName: "mux-workspace-123",
    };

    const result = await withWindow(createMockWindow(calls), () =>
      openInEditor({
        api: null,
        workspaceId,
        targetPath: filePath,
        runtimeConfig,
        isFile: true,
      })
    );

    expect(result.success).toBe(true);
    expect(calls.length).toBe(1);

    const [url, target] = calls[0];
    expect(target).toBe("_blank");
    expect(url.endsWith(filePath)).toBe(false);
    expect(url.endsWith(`/${parentDir}`)).toBe(true);
  });

  test("uses detected server username in development when remote user is unset", async () => {
    const calls: OpenCall[] = [];

    const api = {
      server: {
        getTailscaleSsh: () =>
          Promise.resolve({
            enabled: true,
            sshHost: "devbox.tailnet.ts.net",
            proxyCommand: true,
          }),
        detectTailscale: () => Promise.resolve({ username: "serverdev" }),
      },
    } as unknown as APIClient;

    const result = await withNodeEnv("development", () =>
      withWindow(
        createMockWindow(calls, {
          hostname: "mux.remote.example",
          editorConfig: { editor: "zed" },
          experiments: {
            [getExperimentKey(EXPERIMENT_IDS.TAILSCALE_SSH)]: true,
          },
        }),
        () =>
          openInEditor({
            api,
            workspaceId,
            targetPath: filePath,
            isFile: true,
          })
      )
    );

    expect(result.success).toBe(true);
    expect(calls).toEqual([
      ["zed://ssh/serverdev@devbox.tailnet.ts.net/home/user/project/plan.md:1:1", "_blank"],
    ]);
  });

  test("requires configured remote user in production for tailscale ssh", async () => {
    const calls: OpenCall[] = [];
    const openSettingsCalls: string[] = [];

    const api = {
      server: {
        getTailscaleSsh: () =>
          Promise.resolve({
            enabled: true,
            sshHost: "devbox.tailnet.ts.net",
            proxyCommand: true,
          }),
        detectTailscale: () => Promise.resolve({ username: "serverprod" }),
      },
    } as unknown as APIClient;

    const result = await withNodeEnv("production", () =>
      withWindow(
        createMockWindow(calls, {
          hostname: "mux.remote.example",
          editorConfig: { editor: "zed" },
          experiments: {
            [getExperimentKey(EXPERIMENT_IDS.TAILSCALE_SSH)]: true,
          },
        }),
        () =>
          openInEditor({
            api,
            openSettings: (section) => {
              if (section) {
                openSettingsCalls.push(section);
              }
            },
            workspaceId,
            targetPath: filePath,
            isFile: true,
          })
      )
    );

    expect(result).toEqual({
      success: false,
      error:
        "Configure a Remote User in Settings > General > Tailscale SSH before using Open in editor.",
    });
    expect(calls).toEqual([]);
    expect(openSettingsCalls).toEqual(["general"]);
  });

  test("does not fall back to generic ssh host when production tailscale detection fails", async () => {
    const calls: OpenCall[] = [];
    const openSettingsCalls: string[] = [];

    const api = {
      server: {
        getTailscaleSsh: () =>
          Promise.resolve({
            enabled: true,
            sshHost: "devbox.tailnet.ts.net",
            proxyCommand: true,
          }),
        detectTailscale: () => Promise.reject(new Error("tailscale unavailable")),
        getSshHost: () => Promise.resolve("fallback-host"),
      },
    } as unknown as APIClient;

    const result = await withNodeEnv("production", () =>
      withWindow(
        createMockWindow(calls, {
          hostname: "mux.remote.example",
          editorConfig: { editor: "zed" },
          experiments: {
            [getExperimentKey(EXPERIMENT_IDS.TAILSCALE_SSH)]: true,
          },
        }),
        () =>
          openInEditor({
            api,
            openSettings: (section) => {
              if (section) {
                openSettingsCalls.push(section);
              }
            },
            workspaceId,
            targetPath: filePath,
            isFile: true,
          })
      )
    );

    expect(result).toEqual({
      success: false,
      error:
        "Configure a Remote User in Settings > General > Tailscale SSH before using Open in editor.",
    });
    expect(calls).toEqual([]);
    expect(openSettingsCalls).toEqual(["general"]);
  });

  test("uses the remote Tailscale username for zed browser deep links", async () => {
    const calls: OpenCall[] = [];

    const api = {
      server: {
        getTailscaleSsh: () =>
          Promise.resolve({
            enabled: true,
            sshHost: "devbox.tailnet.ts.net",
            username: "ubuntu",
            proxyCommand: true,
          }),
      },
    } as unknown as APIClient;

    const result = await withWindow(
      createMockWindow(calls, {
        hostname: "mux.remote.example",
        editorConfig: { editor: "zed" },
        experiments: {
          [getExperimentKey(EXPERIMENT_IDS.TAILSCALE_SSH)]: true,
        },
      }),
      () =>
        openInEditor({
          api,
          workspaceId,
          targetPath: filePath,
          isFile: true,
        })
    );

    expect(result.success).toBe(true);
    expect(calls).toEqual([
      ["zed://ssh/ubuntu@devbox.tailnet.ts.net/home/user/project/plan.md:1:1", "_blank"],
    ]);
  });
});
