/**
 * Tailscale SSH config snippet generation for browser mode.
 *
 * When running `mux server` and accessing via browser, we generate copyable
 * SSH config snippets for Tailscale ProxyCommand mode that users can add
 * to their local ~/.ssh/config.
 */

import type { TailscaleInfo } from "@/common/orpc/schemas/api";

export interface TailscaleSshSnippetOptions {
  username?: string;
}

/**
 * Generates an SSH config snippet for Tailscale ProxyCommand mode.
 * This snippet should be added to the user's local ~/.ssh/config.
 */
export function generateTailscaleSshSnippet(
  info: TailscaleInfo,
  options: TailscaleSshSnippetOptions = {}
): string {
  if (!info.hostname && !info.ip) {
    return "";
  }

  const hosts = [info.hostname, info.ip].filter(Boolean).join(" ");
  const user = options.username ?? "$USER"; // Placeholder until user provides username

  return `Host ${hosts}
  ProxyCommand tailscale nc %h %p
  User ${user}
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null`;
}

/**
 * Generates instructions for the user to add the SSH config to their ~/.ssh/config.
 * Returns an empty string if no hostname or IP is available.
 */
export function generateTailscaleSshInstructions(
  info: TailscaleInfo,
  options: TailscaleSshSnippetOptions = {}
): string {
  const snippet = generateTailscaleSshSnippet(info, options);
  if (!snippet) {
    return "";
  }

  return `Add the following to your ~/.ssh/config:

\`\`\`
${snippet}
\`\`\`

Then run: \`ssh-add\` (if using an SSH agent)`;
}
