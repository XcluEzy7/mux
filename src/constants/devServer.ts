export const DEFAULT_DEV_UI_PORT = 3010;
const DEFAULT_DESKTOP_DEV_SERVER_HOST = "127.0.0.1";
const MAX_TCP_PORT = 65_535;

function formatHostForUrl(host: string): string {
  const trimmed = host.trim();
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;

  return unbracketed.includes(":") ? `[${unbracketed.replace(/%(?!25)/gi, "%25")}]` : unbracketed;
}

function getValidPort(rawPort: string | undefined): string | null {
  const trimmedPort = rawPort?.trim();
  if (!trimmedPort || !/^\d+$/.test(trimmedPort)) {
    return null;
  }

  const parsedPort = Number.parseInt(trimmedPort, 10);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > MAX_TCP_PORT) {
    return null;
  }

  return String(parsedPort);
}

function getDesktopDevServerPort(env: NodeJS.ProcessEnv): string {
  return (
    getValidPort(env.MUX_DEVSERVER_PORT) ??
    getValidPort(env.MUX_VITE_PORT) ??
    String(DEFAULT_DEV_UI_PORT)
  );
}

/**
 * Desktop dev windows must follow the active Vite port so `make dev-desktop`
 * and sandboxed Electron sessions always load the same renderer origin.
 */
export function getDesktopDevServerOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.MUX_DEVSERVER_HOST?.trim() || DEFAULT_DESKTOP_DEV_SERVER_HOST;
  const port = getDesktopDevServerPort(env);
  return `http://${formatHostForUrl(host)}:${port}`;
}
