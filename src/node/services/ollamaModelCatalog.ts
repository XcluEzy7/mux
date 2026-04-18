import type { ProviderModelEntry } from "@/common/orpc/types";
import type { ExternalSecretResolver } from "@/common/types/secrets";
import { getErrorMessage } from "@/common/utils/errors";
import {
  getProviderModelEntryId,
  normalizeProviderModelEntries,
} from "@/common/utils/providers/modelEntries";
import { isOpReference } from "@/common/utils/opRef";
import type { ProviderName } from "@/common/constants/providers";
import type { Config, ProviderConfig, ProvidersConfig } from "@/node/config";
import { log } from "@/node/services/log";
import type { ProviderService } from "@/node/services/providerService";
import { resolveProviderCredentials } from "@/node/utils/providerRequirements";

export const OLLAMA_LOCAL_DEFAULT_BASE_URL = "http://127.0.0.1:11434/api";
export const OLLAMA_CLOUD_DEFAULT_BASE_URL = "https://ollama.com/api";
export const OLLAMA_SHOW_DETAILS_CONCURRENCY_LIMIT = 4;

export type RefreshableOllamaProvider = "ollama" | "ollama-cloud";

interface RefreshOptions {
  provider: RefreshableOllamaProvider;
  config: Config;
  providerService: ProviderService;
  opResolver?: ExternalSecretResolver;
}

interface RemoteModelSummary {
  id: string;
  contextWindowTokens: number | null;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizeOllamaApiBaseUrl(
  rawValue: string | undefined,
  provider: RefreshableOllamaProvider
) {
  const fallback =
    provider === "ollama-cloud" ? OLLAMA_CLOUD_DEFAULT_BASE_URL : OLLAMA_LOCAL_DEFAULT_BASE_URL;
  const trimmedValue = rawValue?.trim();
  if (!trimmedValue) {
    return fallback;
  }

  const normalized = stripTrailingSlashes(trimmedValue);
  return normalized.endsWith("/api") ? normalized : `${normalized}/api`;
}

function getRawProviderConfig(
  providersConfig: ProvidersConfig,
  provider: RefreshableOllamaProvider
): ProviderConfig {
  return providersConfig[provider] ?? {};
}

async function resolveProviderHeaders(params: {
  provider: RefreshableOllamaProvider;
  providerConfig: ProviderConfig;
  opResolver?: ExternalSecretResolver;
}): Promise<Record<string, string>> {
  const configuredHeaders =
    params.providerConfig.headers && typeof params.providerConfig.headers === "object"
      ? Object.fromEntries(
          Object.entries(params.providerConfig.headers).filter(
            (entry): entry is [string, string] =>
              typeof entry[0] === "string" && typeof entry[1] === "string"
          )
        )
      : {};

  if (params.provider !== "ollama-cloud") {
    return configuredHeaders;
  }

  const creds = resolveProviderCredentials("ollama-cloud", params.providerConfig);
  if (!creds.isConfigured || !creds.apiKey) {
    throw new Error("Ollama Cloud is not configured — set an API key first");
  }

  let resolvedApiKey = creds.apiKey;
  if (isOpReference(resolvedApiKey)) {
    resolvedApiKey = (await params.opResolver?.(resolvedApiKey)) ?? "";
  }

  if (!resolvedApiKey) {
    throw new Error("Ollama Cloud API key could not be resolved");
  }

  return {
    ...configuredHeaders,
    Authorization: `Bearer ${resolvedApiKey}`,
  };
}

async function fetchOllamaJson(
  url: string,
  init: RequestInit & { timeoutMs?: number }
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? 10_000);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });

    if (response.status === 401) {
      throw new Error("Unauthorized");
    }

    if (!response.ok) {
      let body = "";
      try {
        body = await response.text();
      } catch {
        // Ignore response-body read failures while building the user-visible error.
      }
      const message = body.trim().slice(0, 200) || response.statusText;
      throw new Error(`HTTP ${response.status}: ${message}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Concurrency limit must be a positive integer");
  }

  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(items[currentIndex]);
      }
    })
  );

  return results;
}

function extractModelId(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }

  const record = entry as { name?: unknown; model?: unknown };
  const candidate = typeof record.name === "string" ? record.name : record.model;
  if (typeof candidate !== "string") {
    return null;
  }

  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractContextWindowTokens(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const details = (payload as { details?: unknown }).details;
  if (
    typeof details === "object" &&
    details !== null &&
    typeof (details as { context_length?: unknown }).context_length === "number" &&
    Number.isInteger((details as { context_length: number }).context_length) &&
    (details as { context_length: number }).context_length > 0
  ) {
    return (details as { context_length: number }).context_length;
  }

  const modelInfo = (payload as { model_info?: unknown }).model_info;
  if (typeof modelInfo !== "object" || modelInfo === null) {
    return null;
  }

  for (const [key, value] of Object.entries(modelInfo)) {
    if (!key.endsWith("context_length") && key !== "context_length") {
      continue;
    }

    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }
  }

  return null;
}

async function fetchRemoteModelCatalog(params: {
  provider: RefreshableOllamaProvider;
  providerConfig: ProviderConfig;
  opResolver?: ExternalSecretResolver;
}): Promise<RemoteModelSummary[]> {
  const headers = await resolveProviderHeaders(params);
  const resolvedBaseUrl =
    params.provider === "ollama-cloud"
      ? resolveProviderCredentials("ollama-cloud", params.providerConfig).baseUrl
      : undefined;
  const baseUrl = normalizeOllamaApiBaseUrl(
    resolvedBaseUrl ??
      ((typeof params.providerConfig.baseURL === "string" && params.providerConfig.baseURL) ||
        (typeof params.providerConfig.baseUrl === "string" && params.providerConfig.baseUrl) ||
        undefined),
    params.provider
  );

  const payload = await fetchOllamaJson(`${baseUrl}/tags`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...headers,
    },
  });

  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) {
    throw new Error("Ollama catalog response missing models array");
  }

  const remoteModelIds = models.flatMap((entry) => {
    const modelId = extractModelId(entry);
    return modelId == null ? [] : [modelId];
  });

  const summaries = await mapWithConcurrencyLimit(
    remoteModelIds,
    OLLAMA_SHOW_DETAILS_CONCURRENCY_LIMIT,
    async (modelId) => {
      try {
        const showPayload = await fetchOllamaJson(`${baseUrl}/show`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...headers,
          },
          body: JSON.stringify({ model: modelId }),
        });

        return {
          id: modelId,
          contextWindowTokens: extractContextWindowTokens(showPayload),
        } satisfies RemoteModelSummary;
      } catch (error) {
        log.debug(
          "Failed to fetch Ollama model details; keeping catalog entry without context window",
          {
            provider: params.provider,
            modelId,
            error: getErrorMessage(error),
          }
        );
        return {
          id: modelId,
          contextWindowTokens: null,
        } satisfies RemoteModelSummary;
      }
    }
  );

  return summaries;
}

function mergeCatalogEntries(params: {
  provider: RefreshableOllamaProvider;
  existingEntries: ProviderModelEntry[];
  remoteEntries: RemoteModelSummary[];
}): ProviderModelEntry[] {
  const existingById = new Map(
    params.existingEntries.map((entry) => [getProviderModelEntryId(entry), entry] as const)
  );

  const remoteIds = new Set(params.remoteEntries.map((entry) => entry.id));
  const mergedRemoteEntries = params.remoteEntries.map((remoteEntry) => {
    const existingEntry = existingById.get(remoteEntry.id);
    const existingMappedToModel =
      typeof existingEntry === "object" && existingEntry !== null
        ? existingEntry.mappedToModel
        : undefined;
    const existingContextWindowTokens =
      typeof existingEntry === "object" && existingEntry !== null
        ? existingEntry.contextWindowTokens
        : undefined;
    const contextWindowTokens =
      remoteEntry.contextWindowTokens ?? existingContextWindowTokens ?? undefined;

    if (contextWindowTokens == null && existingMappedToModel == null) {
      return remoteEntry.id;
    }

    return {
      id: remoteEntry.id,
      ...(contextWindowTokens != null ? { contextWindowTokens } : {}),
      ...(typeof existingMappedToModel === "string" && existingMappedToModel.trim().length > 0
        ? { mappedToModel: existingMappedToModel }
        : {}),
    } satisfies ProviderModelEntry;
  });

  if (params.provider === "ollama-cloud") {
    return mergedRemoteEntries;
  }

  const preservedLocalEntries = params.existingEntries.filter(
    (entry) => !remoteIds.has(getProviderModelEntryId(entry))
  );
  return [...mergedRemoteEntries, ...preservedLocalEntries];
}

export async function refreshOllamaProviderCatalog(
  params: RefreshOptions
): Promise<{ modelIds: string[]; persistedEntries: ProviderModelEntry[] }> {
  const providersConfig = params.config.loadProvidersConfig() ?? {};
  const providerConfig = getRawProviderConfig(providersConfig, params.provider);
  const existingEntries = normalizeProviderModelEntries(providerConfig.models);
  const remoteEntries = await fetchRemoteModelCatalog({
    provider: params.provider,
    providerConfig,
    opResolver: params.opResolver,
  });
  const mergedEntries = mergeCatalogEntries({
    provider: params.provider,
    existingEntries,
    remoteEntries,
  });
  const persistedEntries = normalizeProviderModelEntries(mergedEntries);

  const persistResult = params.providerService.setModels(params.provider, persistedEntries);
  if (!persistResult.success) {
    throw new Error(persistResult.error);
  }

  return {
    modelIds: remoteEntries.map((entry) => entry.id),
    persistedEntries,
  };
}

export async function refreshConfiguredOllamaCatalogs(params: {
  config: Config;
  providerService: ProviderService;
  opResolver?: ExternalSecretResolver;
}): Promise<void> {
  const providersConfig = params.config.loadProvidersConfig() ?? {};
  const providersToRefresh: RefreshableOllamaProvider[] = [];

  if (
    providersConfig.ollama != null &&
    providersConfig.ollama.enabled !== false &&
    resolveProviderCredentials("ollama", providersConfig.ollama).isConfigured
  ) {
    providersToRefresh.push("ollama");
  }

  const cloudProviderConfig = getRawProviderConfig(providersConfig, "ollama-cloud");
  if (
    cloudProviderConfig.enabled !== false &&
    resolveProviderCredentials("ollama-cloud", cloudProviderConfig).isConfigured
  ) {
    providersToRefresh.push("ollama-cloud");
  }

  await Promise.all(
    providersToRefresh.map(async (provider) => {
      try {
        await refreshOllamaProviderCatalog({
          provider,
          config: params.config,
          providerService: params.providerService,
          opResolver: params.opResolver,
        });
      } catch (error) {
        log.debug("Skipping startup Ollama catalog refresh after a best-effort failure", {
          provider,
          error: getErrorMessage(error),
        });
      }
    })
  );
}

export function getDefaultOllamaApiBaseUrl(provider: ProviderName): string | null {
  if (provider === "ollama") {
    return OLLAMA_LOCAL_DEFAULT_BASE_URL;
  }

  if (provider === "ollama-cloud") {
    return OLLAMA_CLOUD_DEFAULT_BASE_URL;
  }

  return null;
}
