/**
 * Tailscale SSH config writer for Electron mode.
 *
 * Writes a Tailscale ProxyCommand SSH config block to the user's ~/.ssh/config.
 * Uses marker comments to safely idempotently update/remove the block.
 *
 * Only used in Electron mode (local machine) where we have filesystem access.
 */

import * as crypto from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Marker comments delimiting the Mux Tailscale SSH block. */
export const MUX_TAILSCALE_SSH_BLOCK_START = "# BEGIN MUX TAILSCALE SSH";
export const MUX_TAILSCALE_SSH_BLOCK_END = "# END MUX TAILSCALE SSH";

export interface TailscaleSshConfigOptions {
  /** Primary SSH hostname (required). */
  sshHost: string;
  /** Optional IP address for additional host aliasing. */
  sshIp?: string;
  /** Optional remote SSH username override. */
  username?: string;
  /** Path to ~/.ssh/config (defaults to ~/.ssh/config). */
  sshConfigPath?: string;
}

/** Collision-proof temp path: UUID nonce ensures uniqueness even with concurrent calls. */
function makeAtomicTempPath(sshConfigPath: string): string {
  return `${sshConfigPath}.mux-tmp.${process.pid}.${Date.now()}.${crypto.randomUUID()}`;
}

async function loadSSHConfigContent(
  sshConfigPath: string
): Promise<{ content: string; mode: number }> {
  try {
    const [stats, content] = await Promise.all([
      fsPromises.stat(sshConfigPath),
      fsPromises.readFile(sshConfigPath, "utf8"),
    ]);

    return {
      content,
      mode: stats.mode & 0o777,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return {
        content: "",
        mode: 0o600,
      };
    }

    throw error;
  }
}

async function writeConfigAtomically(
  sshConfigPath: string,
  content: string,
  mode: number
): Promise<void> {
  const tempPath = makeAtomicTempPath(sshConfigPath);

  try {
    await fsPromises.writeFile(tempPath, content, { encoding: "utf8", mode });
    await fsPromises.chmod(tempPath, mode);
    await fsPromises.rename(tempPath, sshConfigPath);
  } catch (error) {
    await fsPromises.rm(tempPath, { force: true });
    throw error;
  }
}

function renderTailscaleBlock(hosts: string, user?: string): string {
  const lines = [
    MUX_TAILSCALE_SSH_BLOCK_START,
    `Host ${hosts}`,
    "  ProxyCommand tailscale nc %h %p",
    "  StrictHostKeyChecking accept-new",
  ];

  // Keep the remote username explicit only when configured. Falling back to
  // the client OS username is unsafe across Windows -> Linux remote flows.
  const trimmedUser = user?.trim();
  if (trimmedUser && trimmedUser.length > 0) {
    lines.splice(3, 0, `  User ${trimmedUser}`);
  }

  lines.push(MUX_TAILSCALE_SSH_BLOCK_END);
  return lines.join("\n");
}

/**
 * Ensures the Mux Tailscale SSH config block exists in ~/.ssh/config.
 * Idempotent: if the block already exists, it will be replaced with updated values.
 *
 * @example
 * await ensureTailscaleSshConfig({ sshHost: "my-machine" });
 */
export async function ensureTailscaleSshConfig(opts: TailscaleSshConfigOptions): Promise<void> {
  const configPath = opts.sshConfigPath ?? path.join(os.homedir(), ".ssh", "config");
  const sshDir = path.dirname(configPath);

  // Ensure the config parent directory exists with restricted permissions
  await fsPromises.mkdir(sshDir, { recursive: true, mode: 0o700 });

  const { content: existingContent, mode: existingMode } = await loadSSHConfigContent(configPath);

  // Check if block already exists
  const startIdx = existingContent.indexOf(MUX_TAILSCALE_SSH_BLOCK_START);
  const endIdx = existingContent.indexOf(MUX_TAILSCALE_SSH_BLOCK_END);

  const hosts = [opts.sshHost, opts.sshIp].filter(Boolean).join(" ");
  const newBlock = renderTailscaleBlock(hosts, opts.username);

  let nextContent: string;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Replace existing block
    const before = existingContent.slice(0, startIdx);
    const after = existingContent.slice(endIdx + MUX_TAILSCALE_SSH_BLOCK_END.length);
    nextContent = (before + newBlock + after).trimEnd() + "\n";
  } else if (startIdx !== -1 || endIdx !== -1) {
    // Self-heal: exactly one marker found (truncated/corrupted block).
    // Strip the partial region, then append the canonical block.
    let cleaned: string;
    if (startIdx !== -1) {
      cleaned = existingContent.slice(0, startIdx);
    } else {
      cleaned = existingContent.slice(endIdx + MUX_TAILSCALE_SSH_BLOCK_END.length);
    }
    nextContent = (cleaned.trimEnd() + "\n" + newBlock).trimEnd() + "\n";
  } else {
    // Append new block
    nextContent =
      existingContent.length === 0
        ? newBlock + "\n"
        : existingContent.endsWith("\n")
          ? existingContent + newBlock + "\n"
          : existingContent + "\n" + newBlock + "\n";
  }

  await writeConfigAtomically(configPath, nextContent, existingMode);
}

/**
 * Removes the Mux Tailscale SSH config block from ~/.ssh/config.
 * Idempotent: no-op if the block doesn't exist.
 */
export async function removeTailscaleSshConfig(sshConfigPath?: string): Promise<void> {
  const configPath = sshConfigPath ?? path.join(os.homedir(), ".ssh", "config");

  try {
    await fsPromises.access(configPath);
  } catch {
    return; // File doesn't exist
  }

  const { content: existingContent, mode } = await loadSSHConfigContent(configPath);
  const startIdx = existingContent.indexOf(MUX_TAILSCALE_SSH_BLOCK_START);
  const endIdx = existingContent.indexOf(MUX_TAILSCALE_SSH_BLOCK_END);

  if ((startIdx !== -1) !== (endIdx !== -1)) {
    // Self-heal: exactly one marker found — strip the partial region
    let cleaned: string;
    if (startIdx !== -1) {
      cleaned = existingContent.slice(0, startIdx);
    } else {
      cleaned = existingContent.slice(endIdx + MUX_TAILSCALE_SSH_BLOCK_END.length);
    }
    const nextContent = cleaned.trimEnd() + "\n";
    await writeConfigAtomically(configPath, nextContent, mode);
    return;
  }

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return; // Block not found, nothing to remove
  }

  const before = existingContent.slice(0, startIdx);
  const after = existingContent.slice(endIdx + MUX_TAILSCALE_SSH_BLOCK_END.length);
  const nextContent = (before + after).trimEnd() + "\n";

  await writeConfigAtomically(configPath, nextContent, mode);
}
