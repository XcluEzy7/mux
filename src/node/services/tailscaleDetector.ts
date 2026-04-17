import { spawn } from "child_process";
import * as os from "os";

export interface TailscaleInfo {
  available: boolean; // Tailscale is running on this machine
  ip: string | null; // 100.x.x.x Tailscale IP
  hostname: string | null; // Tailscale machine name or FQDN
  sshEnabled: boolean; // Tailscale SSH server is active
  tailnet: string | null; // e.g., "tailnet123.ts.net"
}

const TAILSCALE_CIDR_START = (100 << 24) | (64 << 16); // 100.64.0.0
const TAILSCALE_CIDR_MASK = 0xffc00000; // /10 mask

const UNAVAILABLE: TailscaleInfo = {
  available: false,
  ip: null,
  hostname: null,
  sshEnabled: false,
  tailnet: null,
};

const CACHE_TTL_MS = 60_000;

let cachedResult: TailscaleInfo | null = null;
let cacheExpiresAt = 0;

/** Reset the detection cache. Primarily used in tests. */
export function clearTailscaleCache(): void {
  cachedResult = null;
  cacheExpiresAt = 0;
}

/** Returns true if the given IPv4 string falls in the 100.64.0.0/10 Tailscale CGNAT block. */
function isTailscaleIP(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map(Number);
  if (nums.some((n) => isNaN(n) || n < 0 || n > 255)) return false;
  const value = (nums[0]! << 24) | (nums[1]! << 16) | (nums[2]! << 8) | nums[3]!;
  return (value & TAILSCALE_CIDR_MASK) === TAILSCALE_CIDR_START;
}

/**
 * Runs `tailscale status --json` with a 5-second timeout and returns parsed
 * output, or null on any failure (CLI not found, timeout, bad JSON, etc.).
 */
function runTailscaleCLI(): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;

    const proc = spawn("tailscale", ["status", "--json"], {
      stdio: ["ignore", "pipe", "ignore"],
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        resolve(null);
      }
    }, 5_000);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    proc.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout) as Record<string, unknown>;
        resolve(parsed);
      } catch {
        resolve(null);
      }
    });

    proc.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
}

/**
 * Extracts a nested value from a parsed JSON object using a dot-separated path.
 * Returns undefined when any segment is absent or not an object.
 */
function getPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Fallback detection using OS network interfaces when the Tailscale CLI is not
 * available. Checks for a `tailscale0` interface or any 100.x.x.x address in
 * the 100.64.0.0/10 block.
 */
function detectFromNetworkInterfaces(): TailscaleInfo {
  const ifaces = os.networkInterfaces();

  // Check for dedicated tailscale0 interface first
  const tailscaleIface = ifaces["tailscale0"];
  if (tailscaleIface != null) {
    const ipv4 = tailscaleIface.find((a) => a.family === "IPv4");
    if (ipv4 != null) {
      const hostname = os.hostname();
      const isTsNet = hostname.endsWith(".ts.net");
      return {
        available: true,
        ip: ipv4.address,
        hostname,
        sshEnabled: false, // Cannot determine without CLI
        tailnet: isTsNet ? hostname.slice(hostname.indexOf(".") + 1) : null,
      };
    }
  }

  // Scan all interfaces for a 100.x.x.x address
  for (const [, addrs] of Object.entries(ifaces)) {
    if (addrs == null) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && isTailscaleIP(addr.address)) {
        const hostname = os.hostname();
        const isTsNet = hostname.endsWith(".ts.net");
        return {
          available: true,
          ip: addr.address,
          hostname,
          sshEnabled: false,
          tailnet: isTsNet ? hostname.slice(hostname.indexOf(".") + 1) : null,
        };
      }
    }
  }

  return UNAVAILABLE;
}

/**
 * Detect whether Tailscale is running on this machine and return relevant
 * connection info. Results are cached for 60 seconds to avoid repeated
 * subprocess spawns.
 *
 * Returns `{ available: false }` immediately on Windows because Tailscale SSH
 * is not supported there.
 */
export async function detectTailscale(): Promise<TailscaleInfo> {
  // Windows is not supported for Tailscale SSH
  if (process.platform === "win32") {
    return UNAVAILABLE;
  }

  // Return cached result if still valid
  if (cachedResult != null && Date.now() < cacheExpiresAt) {
    return cachedResult;
  }

  const result = await detectTailscaleUncached();
  cachedResult = result;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return result;
}

async function detectTailscaleUncached(): Promise<TailscaleInfo> {
  const json = await runTailscaleCLI();

  if (json == null) {
    // CLI unavailable — fall back to network interface inspection
    return detectFromNetworkInterfaces();
  }

  // `tailscale status --json` top-level shape:
  //   { Self: { Online, TailscaleIPs, DNSName, HostName }, Health: string[] }
  const online = getPath(json, "Self.Online");
  if (online !== true) {
    return UNAVAILABLE;
  }

  // Pick the first Tailscale IP from the array
  const tailscaleIPs = getPath(json, "Self.TailscaleIPs");
  const ip =
    Array.isArray(tailscaleIPs) && tailscaleIPs.length > 0 ? String(tailscaleIPs[0]) : null;

  // DNSName is the fully-qualified name (e.g. "machine.tailnet123.ts.net.")
  // HostName is the short hostname
  const dnsName = getPath(json, "Self.DNSName");
  const hostName = getPath(json, "Self.HostName");
  const fqdn = typeof dnsName === "string" ? dnsName.replace(/\.$/, "") : null;
  const hostname = fqdn ?? (typeof hostName === "string" ? hostName : null);

  // Derive tailnet from the FQDN: everything after the first dot segment
  let tailnet: string | null = null;
  if (fqdn != null) {
    const dotIdx = fqdn.indexOf(".");
    if (dotIdx !== -1) {
      tailnet = fqdn.slice(dotIdx + 1);
    }
  }

  // Check Health array for SSH-related warnings/status.
  // Tailscale SSH server being active isn't always surfaced in `status --json`,
  // but absence of SSH-blocking health warnings is a reasonable heuristic.
  const health = getPath(json, "Health");
  const healthMessages: string[] = Array.isArray(health) ? health.map((h) => String(h)) : [];
  const sshBlocked = healthMessages.some(
    (msg) => /ssh/i.test(msg) && /disabled|blocked|not running/i.test(msg)
  );
  // We conservatively report sshEnabled=true when Tailscale is online and no
  // SSH-blocking health message is found. Callers should attempt a connection
  // to confirm.
  const sshEnabled = !sshBlocked;

  return {
    available: true,
    ip,
    hostname,
    sshEnabled,
    tailnet,
  };
}
