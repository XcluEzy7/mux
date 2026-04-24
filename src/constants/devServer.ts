export const DEFAULT_DEV_UI_PORT = 3010;
const DEFAULT_DESKTOP_DEV_SERVER_HOST = "127.0.0.1";

function formatHostForUrl(host: string): string {
  const trimmed = host.trim();
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;

  return unbracketed.includes(":") ? `[${unbracketed.replace(/%(?!25)/gi, "%25")}]` : unbracketed;
}

/**
 * Desktop dev windows must follow the active Vite port so `make dev-desktop`
 * and sandboxed Electron sessions always load the same renderer origin.
 */
export function getDesktopDevServerOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.MUX_DEVSERVER_HOST ?? DEFAULT_DESKTOP_DEV_SERVER_HOST;
  const port = env.MUX_DEVSERVER_PORT ?? env.MUX_VITE_PORT ?? String(DEFAULT_DEV_UI_PORT);
  return `http://${formatHostForUrl(host)}:${port}`;
}
