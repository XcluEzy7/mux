/**
 * Normalizes a Tailscale SSH username by trimming whitespace.
 * Returns undefined for empty/whitespace-only values.
 */
export function normalizeTailscaleUsername(
  value: string | undefined
): string | undefined {
  const trimmed = value?.trim();
  if (trimmed == null || trimmed.length === 0) {
    return undefined;
  }
  return trimmed;
}