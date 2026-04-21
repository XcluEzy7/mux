import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { isExperimentEnabled } from "@/browser/hooks/useExperiments";
import {
  getEditorDeepLink,
  getDockerDeepLink,
  getDevcontainerDeepLink,
  isLocalhost,
  type DeepLinkEditor,
} from "@/browser/utils/editorDeepLinks";
import {
  DEFAULT_EDITOR_CONFIG,
  EDITOR_CONFIG_KEY,
  type EditorConfig,
} from "@/common/constants/storage";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { RuntimeConfig } from "@/common/types/runtime";
import { isSSHRuntime, isDockerRuntime, isDevcontainerRuntime } from "@/common/types/runtime";
import type { APIClient } from "@/browser/contexts/API";

export interface OpenInEditorResult {
  success: boolean;
  error?: string;
}

// Browser mode: window.api is not set (only exists in Electron via preload).
// Read this at call time so tests and late preload wiring cannot get stuck with
// an import-time snapshot of the environment.
function isBrowserMode(): boolean {
  return typeof window !== "undefined" && !window.api;
}

// Helper for opening URLs - allows testing in Node environment
function openUrl(url: string): void {
  if (typeof window !== "undefined" && window.open) {
    window.open(url, "_blank");
  }
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function normalizePathSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

function buildSshHostWithOptionalUsername(host: string, username?: string): string {
  const trimmedUsername = username?.trim();
  return trimmedUsername ? `${trimmedUsername}@${host}` : host;
}

function resolveTailscaleSshUsername(options: {
  configuredUsername?: string;
  detectedUsername?: string | null;
  isDevelopment: boolean;
}): string | undefined {
  const configuredUsername = options.configuredUsername?.trim();
  if (configuredUsername) {
    return configuredUsername;
  }

  if (!options.isDevelopment) {
    return undefined;
  }

  return options.detectedUsername?.trim();
}

function isDevelopmentMode(): boolean {
  // eslint-disable-next-line no-restricted-globals, no-restricted-syntax
  return process.env.NODE_ENV !== "production";
}

function mapHostPathToContainerPath(options: {
  hostWorkspacePath: string;
  containerWorkspacePath: string;
  targetPath: string;
}): string {
  // Normalize backslashes for Windows compatibility
  const hostWorkspacePath = trimTrailingSlash(normalizePathSeparators(options.hostWorkspacePath));
  const containerWorkspacePath = trimTrailingSlash(options.containerWorkspacePath);
  const targetPath = trimTrailingSlash(normalizePathSeparators(options.targetPath));

  if (targetPath === hostWorkspacePath) {
    return containerWorkspacePath || "/";
  }

  const prefix = `${hostWorkspacePath}/`;
  if (targetPath.startsWith(prefix)) {
    const relative = targetPath.slice(hostWorkspacePath.length);
    if (!relative) {
      return containerWorkspacePath || "/";
    }

    if (containerWorkspacePath === "/") {
      return relative;
    }

    return `${containerWorkspacePath}${relative}`;
  }

  return containerWorkspacePath || "/";
}

/**
 * Get parent directory from a path.
 */
function getParentDirectory(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  const isRootLevelPath = lastSlash === 0; // e.g., /file.txt at root
  return isRootLevelPath ? "/" : path.substring(0, lastSlash) || "/";
}

export async function openInEditor(args: {
  api: APIClient | null | undefined;
  openSettings?: (section?: string) => void;
  workspaceId: string;
  targetPath: string;
  runtimeConfig?: RuntimeConfig;
  /**
   * When true, indicates targetPath is a file.
   *
   * Some deep link formats (e.g. VS Code's Docker attached-container URI) can only
   * open folders/workspaces, so we fall back to opening the parent directory.
   */
  isFile?: boolean;
}): Promise<OpenInEditorResult> {
  const editorConfig = readPersistedState<EditorConfig>(EDITOR_CONFIG_KEY, DEFAULT_EDITOR_CONFIG);

  const isSSH = isSSHRuntime(args.runtimeConfig);
  const isDocker = isDockerRuntime(args.runtimeConfig);

  // For custom editor with no command configured, open settings (if available)
  if (editorConfig.editor === "custom" && !editorConfig.customCommand) {
    args.openSettings?.("general");
    return { success: false, error: "Please configure a custom editor command in Settings" };
  }

  // For SSH workspaces, validate the editor supports SSH connections
  if (isSSH) {
    if (editorConfig.editor === "custom") {
      return {
        success: false,
        error: "Custom editors do not support SSH connections for SSH workspaces",
      };
    }
  }

  // Docker workspaces always use deep links (VS Code connects to container remotely)
  if (isDocker && args.runtimeConfig?.type === "docker") {
    if (editorConfig.editor === "zed") {
      return { success: false, error: "Zed does not support Docker containers" };
    }
    if (editorConfig.editor === "custom") {
      return { success: false, error: "Custom editors do not support Docker containers" };
    }

    const containerName = args.runtimeConfig.containerName;
    if (!containerName) {
      return {
        success: false,
        error: "Container name not available. Try reopening the workspace.",
      };
    }

    // VS Code's attached-container URI scheme only supports opening folders as workspaces,
    // not individual files. Open the parent directory so the file is visible in the file tree.
    const targetDir = args.isFile ? getParentDirectory(args.targetPath) : args.targetPath;
    const deepLink = getDockerDeepLink({
      editor: editorConfig.editor as DeepLinkEditor,
      containerName,
      path: targetDir,
    });

    if (!deepLink) {
      return { success: false, error: `${editorConfig.editor} does not support Docker containers` };
    }

    openUrl(deepLink);
    return { success: true };
  }

  // Devcontainer workspaces use deep links with container info from backend
  const isDevcontainer = isDevcontainerRuntime(args.runtimeConfig);
  if (isDevcontainer && args.runtimeConfig?.type === "devcontainer") {
    if (editorConfig.editor === "zed") {
      return { success: false, error: "Zed does not support Dev Containers" };
    }
    if (editorConfig.editor === "custom") {
      return { success: false, error: "Custom editors do not support Dev Containers" };
    }

    // Fetch container info from backend (on-demand discovery)
    const info = await args.api?.workspace.getDevcontainerInfo({ workspaceId: args.workspaceId });
    if (!info) {
      return {
        success: false,
        error: "Dev Container not running. Try reopening the workspace.",
      };
    }

    // VS Code's dev-container URI scheme only supports opening folders as workspaces,
    // not individual files. Open the parent directory so the file is visible in the file tree.
    const normalizedTargetPath = normalizePathSeparators(args.targetPath);
    const targetDir = args.isFile ? getParentDirectory(normalizedTargetPath) : normalizedTargetPath;

    const hostWorkspacePath = trimTrailingSlash(info.hostWorkspacePath);
    const containerPath = mapHostPathToContainerPath({
      hostWorkspacePath,
      containerWorkspacePath: info.containerWorkspacePath,
      targetPath: targetDir,
    });

    // Build the config file path if available
    const configFilePath = args.runtimeConfig.configPath
      ? isAbsolutePath(args.runtimeConfig.configPath)
        ? args.runtimeConfig.configPath
        : `${hostWorkspacePath}/${args.runtimeConfig.configPath}`
      : undefined;

    const deepLink = getDevcontainerDeepLink({
      editor: editorConfig.editor as DeepLinkEditor,
      containerName: info.containerName,
      hostPath: hostWorkspacePath,
      containerPath,
      configFilePath,
    });

    if (!deepLink) {
      return { success: false, error: `${editorConfig.editor} does not support Dev Containers` };
    }

    openUrl(deepLink);
    return { success: true };
  }

  // VS Code / Cursor / Zed: always use deep links (works in browser + Electron)
  if (editorConfig.editor !== "custom") {
    // Determine SSH host for deep link
    let sshHost: string | undefined;
    if (isSSH && args.runtimeConfig?.type === "ssh") {
      // SSH workspace: use the configured SSH host
      sshHost = args.runtimeConfig.host;
      if (editorConfig.editor === "zed" && args.runtimeConfig.port != null) {
        sshHost = sshHost + ":" + args.runtimeConfig.port;
      }
    } else if (isBrowserMode() && !isLocalhost(window.location.hostname)) {
      // Check Tailscale SSH first (only if experiment is enabled)
      const experimentEnabled = isExperimentEnabled(EXPERIMENT_IDS.TAILSCALE_SSH);
      if (experimentEnabled) {
        try {
          const tailscaleConfig = await args.api?.server.getTailscaleSsh();
          if (tailscaleConfig?.enabled && tailscaleConfig.sshHost) {
            const isDevelopment = isDevelopmentMode();
            let detectedInfo: Awaited<
              ReturnType<NonNullable<typeof args.api>["server"]["detectTailscale"]>
            > | null = null;
            if (tailscaleConfig.username == null) {
              try {
                detectedInfo = (await args.api?.server.detectTailscale({ force: false })) ?? null;
              } catch {
                // In production, detection failures must not bypass the remote-user requirement.
                if (!isDevelopment) {
                  args.openSettings?.("general");
                  return {
                    success: false,
                    error:
                      "Configure a Remote User in Settings > General > Tailscale SSH before using Open in editor.",
                  };
                }
              }
            }

            const tailscaleUsername = resolveTailscaleSshUsername({
              configuredUsername: tailscaleConfig.username,
              detectedUsername: detectedInfo?.username,
              isDevelopment,
            });

            // In production, require explicit settings to avoid silently using the
            // client OS account when the editor resolves SSH defaults.
            if (!tailscaleUsername) {
              if (!isDevelopment) {
                args.openSettings?.("general");
                return {
                  success: false,
                  error:
                    "Configure a Remote User in Settings > General > Tailscale SSH before using Open in editor.",
                };
              }
            } else {
              // Pass the remote account through the deep link so editors like Zed
              // do not guess the client-side username for server connections.
              sshHost = buildSshHostWithOptionalUsername(
                tailscaleConfig.sshHost,
                tailscaleUsername
              );
            }
          }
        } catch {
          // Fall through to the standard SSH host resolution below.
        }
      }
      // Fall back to existing SSH host logic
      if (!sshHost) {
        const serverSshHost = await args.api?.server.getSshHost();
        sshHost = serverSshHost ?? window.location.hostname;
      }
    }
    // else: localhost access to local workspace → no SSH needed

    // VS Code/Cursor SSH deep links treat the path as a folder unless a line/column is present.
    const deepLink = getEditorDeepLink({
      editor: editorConfig.editor as DeepLinkEditor,
      path: args.targetPath,
      sshHost,
      line: args.isFile && sshHost ? 1 : undefined,
      column: args.isFile && sshHost ? 1 : undefined,
    });

    if (!deepLink) {
      return {
        success: false,
        error: `${editorConfig.editor} does not support SSH remote connections`,
      };
    }

    openUrl(deepLink);
    return { success: true };
  }

  // Custom editor:
  // - Browser mode: can't spawn processes on the server
  // - Electron mode: spawn via backend API
  if (isBrowserMode()) {
    return {
      success: false,
      error: "Custom editors are not supported in browser mode. Use VS Code, Cursor, or Zed.",
    };
  }

  const result = await args.api?.general.openInEditor({
    workspaceId: args.workspaceId,
    targetPath: args.targetPath,
    editorConfig,
  });

  if (!result) {
    return { success: false, error: "API not available" };
  }

  if (!result.success) {
    return { success: false, error: result.error };
  }

  return { success: true };
}
