import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import { ProviderService } from "@/node/services/providerService";
import {
  normalizeOllamaApiBaseUrl,
  refreshOllamaProviderCatalog,
  refreshConfiguredOllamaCatalogs,
  OLLAMA_CLOUD_DEFAULT_BASE_URL,
  OLLAMA_LOCAL_DEFAULT_BASE_URL,
  OLLAMA_SHOW_DETAILS_CONCURRENCY_LIMIT,
} from "./ollamaModelCatalog";

async function withTempConfig(
  run: (config: Config, providerService: ProviderService) => Promise<void>
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-ollama-catalog-"));
  try {
    const config = new Config(tmpDir);
    const providerService = new ProviderService(config);
    await run(config, providerService);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const originalFetch = globalThis.fetch;

function setFetchImplementation(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
) {
  globalThis.fetch = Object.assign(implementation, {
    preconnect: originalFetch.preconnect?.bind(originalFetch),
  }) as typeof fetch;
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function parseShowBody(init?: RequestInit): { model: string } {
  if (typeof init?.body !== "string") {
    throw new Error("Expected a JSON string body for Ollama show requests");
  }

  return JSON.parse(init.body) as { model: string };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

describe("normalizeOllamaApiBaseUrl", () => {
  it("appends /api when users provide a host-only local URL", () => {
    expect(normalizeOllamaApiBaseUrl("http://localhost:11434", "ollama")).toBe(
      "http://localhost:11434/api"
    );
  });

  it("keeps explicit /api suffixes and falls back to the documented cloud URL", () => {
    expect(normalizeOllamaApiBaseUrl("https://ollama.example.com/api/", "ollama-cloud")).toBe(
      "https://ollama.example.com/api"
    );
    expect(normalizeOllamaApiBaseUrl(undefined, "ollama-cloud")).toBe(
      OLLAMA_CLOUD_DEFAULT_BASE_URL
    );
    expect(normalizeOllamaApiBaseUrl(undefined, "ollama")).toBe(OLLAMA_LOCAL_DEFAULT_BASE_URL);
  });
});

describe("refreshOllamaProviderCatalog", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("merges live local Ollama models with unmatched custom entries", async () => {
    await withTempConfig(async (config, providerService) => {
      config.saveProvidersConfig({
        ollama: {
          models: [
            { id: "existing-local", mappedToModel: "anthropic:claude-sonnet-4-6" },
            "custom-only",
          ],
        },
      });

      setFetchImplementation((input, init) => {
        const url = getRequestUrl(input);
        if (url === `${OLLAMA_LOCAL_DEFAULT_BASE_URL}/tags`) {
          return Promise.resolve(
            jsonResponse({
              models: [{ name: "existing-local" }, { name: "new-remote" }],
            })
          );
        }

        const body = parseShowBody(init);
        if (body.model === "existing-local") {
          return Promise.resolve(jsonResponse({ model_info: { "general.context_length": 8192 } }));
        }

        if (body.model === "new-remote") {
          return Promise.resolve(jsonResponse({ details: { context_length: 16384 } }));
        }

        throw new Error(`Unexpected Ollama show request for ${body.model}`);
      });

      const result = await refreshOllamaProviderCatalog({
        provider: "ollama",
        config,
        providerService,
      });

      expect(result.modelIds).toEqual(["existing-local", "new-remote"]);
      expect(config.loadProvidersConfig()?.ollama?.models).toEqual([
        {
          id: "existing-local",
          contextWindowTokens: 8192,
          mappedToModel: "anthropic:claude-sonnet-4-6",
        },
        { id: "new-remote", contextWindowTokens: 16384 },
        "custom-only",
      ]);
    });
  });

  it("treats the cloud catalog as authoritative while preserving matching custom mappings", async () => {
    await withTempConfig(async (config, providerService) => {
      config.saveProvidersConfig({
        "ollama-cloud": {
          apiKey: "ollama_test_key",
          models: ["stale-cloud", { id: "keep-mapping", mappedToModel: "openai:gpt-5.4" }],
        },
      });

      setFetchImplementation((input, init) => {
        const url = getRequestUrl(input);
        const authHeader = new Headers(init?.headers).get("Authorization");
        expect(authHeader).toBe("Bearer ollama_test_key");

        if (url === `${OLLAMA_CLOUD_DEFAULT_BASE_URL}/tags`) {
          return Promise.resolve(
            jsonResponse({
              models: [{ name: "keep-mapping" }, { name: "new-cloud" }],
            })
          );
        }

        const body = parseShowBody(init);
        if (body.model === "keep-mapping") {
          return Promise.resolve(jsonResponse({ details: {} }));
        }

        if (body.model === "new-cloud") {
          return Promise.resolve(jsonResponse({ model_info: { context_length: 32768 } }));
        }

        throw new Error(`Unexpected Ollama Cloud show request for ${body.model}`);
      });

      const result = await refreshOllamaProviderCatalog({
        provider: "ollama-cloud",
        config,
        providerService,
      });

      expect(result.modelIds).toEqual(["keep-mapping", "new-cloud"]);
      expect(config.loadProvidersConfig()?.["ollama-cloud"]?.models).toEqual([
        { id: "keep-mapping", mappedToModel: "openai:gpt-5.4" },
        { id: "new-cloud", contextWindowTokens: 32768 },
      ]);
    });
  });

  it("uses env-resolved ollama-cloud base URL during refresh", async () => {
    await withTempConfig(async (config, providerService) => {
      const originalCloudBaseUrl = process.env.OLLAMA_CLOUD_BASE_URL;
      const originalFallbackBaseUrl = process.env.OLLAMA_BASE_URL;

      process.env.OLLAMA_CLOUD_BASE_URL = "https://proxy.example.com/ollama";
      delete process.env.OLLAMA_BASE_URL;

      config.saveProvidersConfig({
        "ollama-cloud": {
          apiKey: "ollama_test_key",
          models: ["stale-cloud"],
        },
      });

      try {
        setFetchImplementation((input, init) => {
          const url = getRequestUrl(input);
          if (url === "https://proxy.example.com/ollama/api/tags") {
            return Promise.resolve(jsonResponse({ models: [{ name: "proxied-cloud" }] }));
          }

          if (url === "https://proxy.example.com/ollama/api/show") {
            const body = parseShowBody(init);
            return Promise.resolve(
              jsonResponse({ details: { context_length: 4096 }, name: body.model })
            );
          }

          throw new Error(`Unexpected request for ${url}`);
        });

        const result = await refreshOllamaProviderCatalog({
          provider: "ollama-cloud",
          config,
          providerService,
        });

        expect(result.modelIds).toEqual(["proxied-cloud"]);
      } finally {
        restoreEnv("OLLAMA_CLOUD_BASE_URL", originalCloudBaseUrl);
        restoreEnv("OLLAMA_BASE_URL", originalFallbackBaseUrl);
      }
    });
  });

  it("allows empty cloud catalogs and clears stale authoritative entries", async () => {
    await withTempConfig(async (config, providerService) => {
      config.saveProvidersConfig({
        "ollama-cloud": {
          apiKey: "ollama_test_key",
          models: ["stale-cloud"],
        },
      });

      setFetchImplementation((input) => {
        const url = getRequestUrl(input);
        if (url === `${OLLAMA_CLOUD_DEFAULT_BASE_URL}/tags`) {
          return Promise.resolve(jsonResponse({ models: [] }));
        }

        throw new Error(`Unexpected request for ${url}`);
      });

      const result = await refreshOllamaProviderCatalog({
        provider: "ollama-cloud",
        config,
        providerService,
      });

      expect(result.modelIds).toEqual([]);
      expect(config.loadProvidersConfig()?.["ollama-cloud"]?.models).toEqual([]);
    });
  });

  it("caps concurrent Ollama show requests", async () => {
    await withTempConfig(async (config, providerService) => {
      config.saveProvidersConfig({
        ollama: {
          models: ["seed"],
        },
      });

      let activeShowRequests = 0;
      let maxActiveShowRequests = 0;

      setFetchImplementation((input, init) => {
        const url = getRequestUrl(input);
        if (url === `${OLLAMA_LOCAL_DEFAULT_BASE_URL}/tags`) {
          return Promise.resolve(
            jsonResponse({
              models: Array.from({ length: 8 }, (_, index) => ({ name: `model-${index}` })),
            })
          );
        }

        if (url === `${OLLAMA_LOCAL_DEFAULT_BASE_URL}/show`) {
          const body = parseShowBody(init);
          activeShowRequests += 1;
          maxActiveShowRequests = Math.max(maxActiveShowRequests, activeShowRequests);

          return new Promise((resolve) => {
            setTimeout(() => {
              activeShowRequests -= 1;
              resolve(jsonResponse({ details: { context_length: 4096 }, name: body.model }));
            }, 5);
          });
        }

        throw new Error(`Unexpected request for ${url}`);
      });

      await refreshOllamaProviderCatalog({
        provider: "ollama",
        config,
        providerService,
      });

      expect(maxActiveShowRequests).toBeLessThanOrEqual(OLLAMA_SHOW_DETAILS_CONCURRENCY_LIMIT);
    });
  });
});

describe("refreshConfiguredOllamaCatalogs", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("skips disabled providers during startup refresh", async () => {
    await withTempConfig(async (config, providerService) => {
      config.saveProvidersConfig({
        ollama: {
          enabled: false,
          models: ["local-disabled"],
        },
        "ollama-cloud": {
          apiKey: "ollama_test_key",
          models: ["cloud-enabled"],
        },
      });

      let tagRequests = 0;
      setFetchImplementation((input, init) => {
        const url = getRequestUrl(input);
        if (url === `${OLLAMA_CLOUD_DEFAULT_BASE_URL}/tags`) {
          tagRequests += 1;
          return Promise.resolve(jsonResponse({ models: [{ name: "cloud-enabled" }] }));
        }

        if (url === `${OLLAMA_CLOUD_DEFAULT_BASE_URL}/show`) {
          const body = parseShowBody(init);
          return Promise.resolve(
            jsonResponse({ details: { context_length: 4096 }, name: body.model })
          );
        }

        if (url === `${OLLAMA_LOCAL_DEFAULT_BASE_URL}/tags`) {
          throw new Error("Disabled local Ollama provider should not refresh at startup");
        }

        throw new Error(`Unexpected request for ${url}`);
      });

      await refreshConfiguredOllamaCatalogs({
        config,
        providerService,
      });

      expect(tagRequests).toBe(1);
    });
  });
});
