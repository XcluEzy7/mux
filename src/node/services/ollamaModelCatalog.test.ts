import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import { ProviderService } from "@/node/services/providerService";
import {
  normalizeOllamaApiBaseUrl,
  refreshOllamaProviderCatalog,
  OLLAMA_CLOUD_DEFAULT_BASE_URL,
  OLLAMA_LOCAL_DEFAULT_BASE_URL,
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
});
