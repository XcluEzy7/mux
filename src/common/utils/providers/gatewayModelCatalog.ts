import type { ProviderModelEntry } from "@/common/orpc/types";

import { normalizeCopilotModelId } from "@/common/utils/copilot/modelRouting";
import { maybeGetProviderModelEntryId } from "@/common/utils/providers/modelEntries";

export function isProviderModelAccessibleFromAuthoritativeCatalog(
  provider: string,
  modelId: string,
  models: ProviderModelEntry[] | undefined
): boolean {
  // Most provider config model lists are user-managed custom entries, not exhaustive
  // server catalogs. GitHub Copilot and Synthetic.new are exceptions because their
  // model-refresh endpoints store the full catalog returned by the server.
  if (provider !== "github-copilot" && provider !== "synthetic-new") {
    return true;
  }

  if (!Array.isArray(models) || models.length === 0) {
    return true;
  }

  // For GitHub Copilot, use normalized ID comparison (handles prefix-based mapping)
  if (provider === "github-copilot") {
    const normalizedModelId = normalizeCopilotModelId(modelId);
    let foundValidEntry = false;
    for (const entry of models) {
      const configuredModelId = maybeGetProviderModelEntryId(entry);
      if (configuredModelId == null) {
        continue;
      }

      foundValidEntry = true;
      if (normalizeCopilotModelId(configuredModelId) === normalizedModelId) {
        return true;
      }
    }

    return !foundValidEntry;
  }

  // For Synthetic.new, direct ID comparison (IDs from /models endpoint are authoritative)
  let foundValidEntry = false;
  for (const entry of models) {
    const configuredModelId = maybeGetProviderModelEntryId(entry);
    if (configuredModelId == null) {
      continue;
    }

    foundValidEntry = true;
    if (configuredModelId === modelId) {
      return true;
    }
  }

  return !foundValidEntry;
}

export function isGatewayModelAccessibleFromAuthoritativeCatalog(
  gateway: string,
  modelId: string,
  models: ProviderModelEntry[] | undefined
): boolean {
  return isProviderModelAccessibleFromAuthoritativeCatalog(gateway, modelId, models);
}
