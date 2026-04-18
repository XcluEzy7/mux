import * as crypto from "crypto";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import {
  buildCodexAuthorizeUrl,
  buildCodexRefreshBody,
  buildCodexTokenExchangeBody,
  CODEX_OAUTH_BROWSER_REDIRECT_URI,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_DEVICE_TOKEN_POLL_URL,
  CODEX_OAUTH_DEVICE_USERCODE_URL,
  CODEX_OAUTH_DEVICE_VERIFY_URL,
  CODEX_OAUTH_TOKEN_URL,
  CODEX_OAUTH_WHAM_USAGE_URL,
} from "@/common/constants/codexOAuth";
import type { Config } from "@/node/config";
import type { ProviderService } from "@/node/services/providerService";
import type { WindowService } from "@/node/services/windowService";
import { log } from "@/node/services/log";
import { sleepWithAbort } from "@/node/utils/abort";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import {
  extractAccountIdFromTokens,
  isCodexOauthAuthExpired,
  parseCodexOauthAuth,
  type CodexOauthAuth,
} from "@/node/utils/codexOauthAuth";
import { createDeferred } from "@/node/utils/oauthUtils";
import { startLoopbackServer } from "@/node/utils/oauthLoopbackServer";
import { OAuthFlowManager } from "@/node/utils/oauthFlowManager";
import { getErrorMessage } from "@/common/utils/errors";

const DEFAULT_DESKTOP_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_DEVICE_TIMEOUT_MS = 15 * 60 * 1000;
const COMPLETED_FLOW_TTL_MS = 60 * 1000;

const ACCOUNT_STATUS_CACHE_TTL_MS = 45 * 1000;

type CodexOauthAccountStatusState = "connected" | "disconnected" | "unsupported";
type CodexOauthAccountStatusSource = "wham" | "response-headers";

export interface CodexOauthRateLimitWindow {
  usedPercent: number | null;
  windowMinutes: number | null;
  resetsAt: string | null;
}

export interface CodexOauthCreditsStatus {
  hasCredits: boolean | null;
  unlimited: boolean | null;
  balance: number | null;
}

export interface CodexOauthAccountStatus {
  state: CodexOauthAccountStatusState;
  source: CodexOauthAccountStatusSource | null;
  primaryWindow: CodexOauthRateLimitWindow;
  secondaryWindow: CodexOauthRateLimitWindow;
  credits: CodexOauthCreditsStatus;
  fetchedAtMs: number | null;
  message: string | null;
}

interface CodexOauthStatusCacheEntry {
  status: CodexOauthAccountStatus;
  fetchedAtMs: number;
}

interface ParsedCodexHeaderStatus {
  hasSignal: boolean;
  primaryWindow: CodexOauthRateLimitWindow;
  secondaryWindow: CodexOauthRateLimitWindow;
  credits: CodexOauthCreditsStatus;
}

interface DeviceFlow {
  flowId: string;
  deviceAuthId: string;
  userCode: string;
  verifyUrl: string;
  intervalSeconds: number;
  expiresAtMs: number;

  abortController: AbortController;
  pollingStarted: boolean;

  timeout: ReturnType<typeof setTimeout>;
  cleanupTimeout: ReturnType<typeof setTimeout> | null;

  resultPromise: Promise<Result<void, string>>;
  resolveResult: (result: Result<void, string>) => void;
  settled: boolean;
}

function sha256Base64Url(value: string): string {
  return crypto.createHash("sha256").update(value).digest().toString("base64url");
}

function randomBase64Url(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  return null;
}

function isInvalidGrantError(errorText: string): boolean {
  const trimmed = errorText.trim();
  if (trimmed.length === 0) {
    return false;
  }

  try {
    const json = JSON.parse(trimmed) as unknown;
    if (isPlainObject(json) && json.error === "invalid_grant") {
      return true;
    }
  } catch {
    // Ignore parse failures - fall back to substring checks.
  }

  const lower = trimmed.toLowerCase();
  return lower.includes("invalid_grant") || lower.includes("revoked");
}

function emptyRateLimitWindow(): CodexOauthRateLimitWindow {
  return {
    usedPercent: null,
    windowMinutes: null,
    resetsAt: null,
  };
}

function emptyCreditsStatus(): CodexOauthCreditsStatus {
  return {
    hasCredits: null,
    unlimited: null,
    balance: null,
  };
}

function disconnectedAccountStatus(): CodexOauthAccountStatus {
  return {
    state: "disconnected",
    source: null,
    primaryWindow: emptyRateLimitWindow(),
    secondaryWindow: emptyRateLimitWindow(),
    credits: emptyCreditsStatus(),
    fetchedAtMs: null,
    message: null,
  };
}

function unsupportedAccountStatus(message: string): CodexOauthAccountStatus {
  return {
    state: "unsupported",
    source: null,
    primaryWindow: emptyRateLimitWindow(),
    secondaryWindow: emptyRateLimitWindow(),
    credits: emptyCreditsStatus(),
    fetchedAtMs: Date.now(),
    message,
  };
}

function parseOptionalBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }

  return null;
}

function parseOptionalTimestamp(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  const numeric = parseOptionalNumber(value);
  if (numeric !== null) {
    const milliseconds = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  return null;
}

function parseRateLimitWindow(value: unknown): CodexOauthRateLimitWindow {
  const empty = emptyRateLimitWindow();
  if (!isPlainObject(value)) {
    return empty;
  }

  return {
    usedPercent:
      parseOptionalNumber(value.used_percent) ??
      parseOptionalNumber(value.usedPercent) ??
      parseOptionalNumber(value.used_percentage) ??
      parseOptionalNumber(value.usedPercentage) ??
      parseOptionalNumber(value.used),
    windowMinutes:
      parseOptionalNumber(value.window_minutes) ??
      parseOptionalNumber(value.windowMinutes) ??
      parseOptionalNumber(value.window_mins) ??
      parseOptionalNumber(value.windowMins),
    resetsAt:
      parseOptionalTimestamp(value.reset_at) ??
      parseOptionalTimestamp(value.resets_at) ??
      parseOptionalTimestamp(value.resetAt) ??
      parseOptionalTimestamp(value.resetsAt),
  };
}

function parseCreditsStatus(value: unknown): CodexOauthCreditsStatus {
  const empty = emptyCreditsStatus();
  if (!isPlainObject(value)) {
    return empty;
  }

  return {
    hasCredits:
      parseOptionalBoolean(value.has_credits) ??
      parseOptionalBoolean(value.hasCredits) ??
      parseOptionalBoolean(value.has_credit),
    unlimited: parseOptionalBoolean(value.unlimited),
    balance: parseOptionalNumber(value.balance),
  };
}

function parseCodexHeaderStatus(headers: Headers): ParsedCodexHeaderStatus {
  const primaryWindow: CodexOauthRateLimitWindow = {
    usedPercent: parseOptionalNumber(headers.get("x-codex-primary-used-percent")),
    windowMinutes: parseOptionalNumber(headers.get("x-codex-primary-window-minutes")),
    resetsAt: parseOptionalTimestamp(headers.get("x-codex-primary-reset-at")),
  };

  const secondaryWindow: CodexOauthRateLimitWindow = {
    usedPercent: parseOptionalNumber(headers.get("x-codex-secondary-used-percent")),
    windowMinutes: parseOptionalNumber(headers.get("x-codex-secondary-window-minutes")),
    resetsAt: parseOptionalTimestamp(headers.get("x-codex-secondary-reset-at")),
  };

  const credits: CodexOauthCreditsStatus = {
    hasCredits: parseOptionalBoolean(headers.get("x-codex-credits-has-credits")),
    unlimited: parseOptionalBoolean(headers.get("x-codex-credits-unlimited")),
    balance: parseOptionalNumber(headers.get("x-codex-credits-balance")),
  };

  const hasSignal =
    primaryWindow.usedPercent !== null ||
    primaryWindow.windowMinutes !== null ||
    primaryWindow.resetsAt !== null ||
    secondaryWindow.usedPercent !== null ||
    secondaryWindow.windowMinutes !== null ||
    secondaryWindow.resetsAt !== null ||
    credits.hasCredits !== null ||
    credits.unlimited !== null ||
    credits.balance !== null;

  return { hasSignal, primaryWindow, secondaryWindow, credits };
}

function mergeWindow(
  preferred: CodexOauthRateLimitWindow,
  fallback: CodexOauthRateLimitWindow
): CodexOauthRateLimitWindow {
  return {
    usedPercent: preferred.usedPercent ?? fallback.usedPercent,
    windowMinutes: preferred.windowMinutes ?? fallback.windowMinutes,
    resetsAt: preferred.resetsAt ?? fallback.resetsAt,
  };
}

function mergeCredits(
  preferred: CodexOauthCreditsStatus,
  fallback: CodexOauthCreditsStatus
): CodexOauthCreditsStatus {
  return {
    hasCredits: preferred.hasCredits ?? fallback.hasCredits,
    unlimited: preferred.unlimited ?? fallback.unlimited,
    balance: preferred.balance ?? fallback.balance,
  };
}

function hasAnyAccountStatusSignal(status: {
  primaryWindow: CodexOauthRateLimitWindow;
  secondaryWindow: CodexOauthRateLimitWindow;
  credits: CodexOauthCreditsStatus;
}): boolean {
  return (
    status.primaryWindow.usedPercent !== null ||
    status.primaryWindow.windowMinutes !== null ||
    status.primaryWindow.resetsAt !== null ||
    status.secondaryWindow.usedPercent !== null ||
    status.secondaryWindow.windowMinutes !== null ||
    status.secondaryWindow.resetsAt !== null ||
    status.credits.hasCredits !== null ||
    status.credits.unlimited !== null ||
    status.credits.balance !== null
  );
}

export class CodexOauthService {
  private readonly desktopFlows = new OAuthFlowManager();
  private readonly deviceFlows = new Map<string, DeviceFlow>();

  private readonly refreshMutex = new AsyncMutex();

  // In-memory cache so getValidAuth() skips disk reads when tokens are valid.
  // Invalidated on every write (exchange, refresh, disconnect).
  private cachedAuth: CodexOauthAuth | null = null;

  // In-memory cache for account status pulled from /wham/usage or response headers.
  // Ephemeral only: never persisted to providers.json.
  private cachedAccountStatus: CodexOauthStatusCacheEntry | null = null;

  constructor(
    private readonly config: Config,
    private readonly providerService: ProviderService,
    private readonly windowService?: WindowService
  ) {}

  async disconnect(): Promise<Result<void, string>> {
    // Clear stored ChatGPT OAuth tokens so Codex-only models are hidden again.
    this.cachedAuth = null;
    this.cachedAccountStatus = null;
    return await this.providerService.setConfigValue("openai", ["codexOauth"], undefined);
  }

  async startDesktopFlow(): Promise<Result<{ flowId: string; authorizeUrl: string }, string>> {
    const flowId = randomBase64Url();

    const codeVerifier = randomBase64Url();
    const codeChallenge = sha256Base64Url(codeVerifier);
    const redirectUri = CODEX_OAUTH_BROWSER_REDIRECT_URI;

    let loopback: Awaited<ReturnType<typeof startLoopbackServer>>;
    try {
      loopback = await startLoopbackServer({
        port: 1455,
        host: "localhost",
        callbackPath: "/auth/callback",
        validateLoopback: true,
        expectedState: flowId,
        deferSuccessResponse: true,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to start OAuth callback listener: ${message}`);
    }

    const resultDeferred = createDeferred<Result<void, string>>();

    this.desktopFlows.register(flowId, {
      server: loopback.server,
      resultDeferred,
      // Keep server-side timeout tied to flow lifetime so abandoned flows
      // (e.g. callers that never invoke waitForDesktopFlow) still self-clean.
      timeoutHandle: setTimeout(() => {
        void this.desktopFlows.finish(flowId, Err("Timed out waiting for OAuth callback"));
      }, DEFAULT_DESKTOP_TIMEOUT_MS),
      codeVerifier,
    });

    const authorizeUrl = buildCodexAuthorizeUrl({
      redirectUri,
      state: flowId,
      codeChallenge,
    });

    // Background task: wait for the loopback callback, exchange code for tokens,
    // then finish the flow. Races against resultDeferred (which resolves on
    // cancel/timeout) so the task exits cleanly if the flow is cancelled.
    void (async () => {
      const callbackResult = await Promise.race([
        loopback.result,
        resultDeferred.promise.then(() => null),
      ]);

      // null means the flow was finished externally (cancel/timeout).
      if (!callbackResult) return;

      if (!callbackResult.success) {
        await this.desktopFlows.finish(flowId, Err(callbackResult.error));
        return;
      }

      const exchangeResult = await this.handleDesktopCallbackAndExchange({
        flowId,
        redirectUri,
        codeVerifier,
        code: callbackResult.data.code ?? undefined,
        error: undefined,
        errorDescription: undefined,
      });

      if (exchangeResult.success) {
        loopback.sendSuccessResponse();
      } else {
        loopback.sendFailureResponse(exchangeResult.error);
      }

      await this.desktopFlows.finish(flowId, exchangeResult);
    })();

    log.debug(`[Codex OAuth] Desktop flow started (flowId=${flowId})`);

    return Ok({ flowId, authorizeUrl });
  }

  async waitForDesktopFlow(
    flowId: string,
    opts?: { timeoutMs?: number }
  ): Promise<Result<void, string>> {
    return this.desktopFlows.waitFor(flowId, opts?.timeoutMs ?? DEFAULT_DESKTOP_TIMEOUT_MS);
  }

  async cancelDesktopFlow(flowId: string): Promise<void> {
    if (this.desktopFlows.has(flowId)) {
      log.debug(`[Codex OAuth] Desktop flow cancelled (flowId=${flowId})`);
    }
    await this.desktopFlows.cancel(flowId);
  }
  async completeDesktopFlowManually(input: {
    flowId: string;
    callbackUrl: string;
  }): Promise<Result<void, string>> {
    const flow = this.desktopFlows.get(input.flowId);
    if (!flow) {
      return Err("OAuth flow not found");
    }

    // Parse callback URL for OAuth params
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(input.callbackUrl);
    } catch {
      return Err("Invalid callback URL format");
    }

    // Validate hostname (localhost or 127.0.0.1 only)
    const hostname = parsedUrl.hostname.toLowerCase();
    if (hostname !== "localhost" && hostname !== "127.0.0.1") {
      return Err("Callback URL must use localhost or 127.0.0.1");
    }

    // Validate pathname (/auth/callback)
    if (parsedUrl.pathname !== "/auth/callback") {
      return Err("Callback URL must have pathname /auth/callback");
    }

    // Extract OAuth params from query string
    const code = parsedUrl.searchParams.get("code");
    const state = parsedUrl.searchParams.get("state");
    const error = parsedUrl.searchParams.get("error");
    const errorDescription = parsedUrl.searchParams.get("error_description");

    // Validate state matches flowId
    if (!state || state !== input.flowId) {
      return Err("OAuth state mismatch. Callback state does not match flow ID");
    }

    // Retrieve stored codeVerifier
    const codeVerifier = flow.codeVerifier;
    if (!codeVerifier) {
      return Err("Code verifier not found for this flow");
    }

    // Exchange code for tokens
    const exchangeResult = await this.handleDesktopCallbackAndExchange({
      flowId: input.flowId,
      redirectUri: CODEX_OAUTH_BROWSER_REDIRECT_URI,
      codeVerifier,
      code: code ?? undefined,
      error: error ?? undefined,
      errorDescription: errorDescription ?? undefined,
    });

    return exchangeResult;
  }

  async startDeviceFlow(): Promise<
    Result<
      {
        flowId: string;
        userCode: string;
        verifyUrl: string;
        intervalSeconds: number;
      },
      string
    >
  > {
    const flowId = randomBase64Url();

    const deviceAuthResult = await this.requestDeviceUserCode();
    if (!deviceAuthResult.success) {
      return Err(deviceAuthResult.error);
    }

    const { deviceAuthId, userCode, intervalSeconds, expiresAtMs } = deviceAuthResult.data;
    const verifyUrl = CODEX_OAUTH_DEVICE_VERIFY_URL;

    const { promise: resultPromise, resolve: resolveResult } =
      createDeferred<Result<void, string>>();

    const abortController = new AbortController();

    const timeoutMs = Math.min(DEFAULT_DEVICE_TIMEOUT_MS, Math.max(0, expiresAtMs - Date.now()));
    const timeout = setTimeout(() => {
      void this.finishDeviceFlow(flowId, Err("Device code expired"));
    }, timeoutMs);

    this.deviceFlows.set(flowId, {
      flowId,
      deviceAuthId,
      userCode,
      verifyUrl,
      intervalSeconds,
      expiresAtMs,
      abortController,
      pollingStarted: false,
      timeout,
      cleanupTimeout: null,
      resultPromise,
      resolveResult,
      settled: false,
    });

    log.debug(`[Codex OAuth] Device flow started (flowId=${flowId})`);

    return Ok({ flowId, userCode, verifyUrl, intervalSeconds });
  }

  async waitForDeviceFlow(
    flowId: string,
    opts?: { timeoutMs?: number }
  ): Promise<Result<void, string>> {
    const flow = this.deviceFlows.get(flowId);
    if (!flow) {
      return Err("OAuth flow not found");
    }

    if (!flow.pollingStarted) {
      flow.pollingStarted = true;
      this.pollDeviceFlow(flowId).catch((error) => {
        // The polling loop is responsible for resolving the flow; if we reach
        // here something unexpected happened.
        const message = getErrorMessage(error);
        log.warn(`[Codex OAuth] Device polling crashed (flowId=${flowId}): ${message}`);
        void this.finishDeviceFlow(flowId, Err(`Device polling crashed: ${message}`));
      });
    }

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_DEVICE_TIMEOUT_MS;

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<Result<void, string>>((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve(Err("Timed out waiting for device authorization"));
      }, timeoutMs);
    });

    const result = await Promise.race([flow.resultPromise, timeoutPromise]);

    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }

    if (!result.success) {
      // Ensure polling is cancelled on timeout/errors.
      void this.finishDeviceFlow(flowId, result);
    }

    return result;
  }

  async cancelDeviceFlow(flowId: string): Promise<void> {
    const flow = this.deviceFlows.get(flowId);
    if (!flow) return;

    log.debug(`[Codex OAuth] Device flow cancelled (flowId=${flowId})`);
    await this.finishDeviceFlow(flowId, Err("OAuth flow cancelled"));
  }

  async getValidAuth(): Promise<Result<CodexOauthAuth, string>> {
    const stored = this.readStoredAuth();
    if (!stored) {
      return Err("Codex OAuth is not configured");
    }

    if (!isCodexOauthAuthExpired(stored)) {
      return Ok(stored);
    }

    await using _lock = await this.refreshMutex.acquire();

    // Re-read after acquiring lock in case another caller refreshed first.
    const latest = this.readStoredAuth();
    if (!latest) {
      return Err("Codex OAuth is not configured");
    }

    if (!isCodexOauthAuthExpired(latest)) {
      return Ok(latest);
    }

    const refreshed = await this.refreshTokens(latest);
    if (!refreshed.success) {
      return Err(refreshed.error);
    }

    return Ok(refreshed.data);
  }

  async getAccountStatus(): Promise<Result<CodexOauthAccountStatus, string>> {
    const stored = this.readStoredAuth();
    if (!stored) {
      this.cachedAccountStatus = null;
      return Ok(disconnectedAccountStatus());
    }

    const cached = this.cachedAccountStatus;
    const canUseStatusCache = !isCodexOauthAuthExpired(stored);
    if (
      canUseStatusCache &&
      cached &&
      Date.now() - cached.fetchedAtMs <= ACCOUNT_STATUS_CACHE_TTL_MS
    ) {
      return Ok(cached.status);
    }

    const authResult = await this.getValidAuth();
    if (!authResult.success) {
      if (authResult.error.includes("not configured")) {
        this.cachedAccountStatus = null;
        return Ok(disconnectedAccountStatus());
      }
      return Err(`Codex OAuth account status request failed: ${authResult.error}`);
    }

    let response: Response;
    try {
      const headers = new Headers({
        Accept: "application/json",
        Authorization: `Bearer ${authResult.data.access}`,
      });
      if (authResult.data.accountId) {
        headers.set("ChatGPT-Account-Id", authResult.data.accountId);
      }

      response = await fetch(CODEX_OAUTH_WHAM_USAGE_URL, { headers });
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Codex OAuth account status request failed: ${message}`);
    }

    if (response.status === 404) {
      const status = unsupportedAccountStatus("OpenAI account status endpoint is unavailable");
      this.cachedAccountStatus = {
        status,
        fetchedAtMs: Date.now(),
      };
      return Ok(status);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const prefix = `Codex OAuth account status request failed (${response.status})`;
      return Err(errorText ? `${prefix}: ${errorText}` : prefix);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      const headerOnlyStatus = this.statusFromHeaders(response.headers);
      if (headerOnlyStatus) {
        this.cachedAccountStatus = {
          status: headerOnlyStatus,
          fetchedAtMs: Date.now(),
        };
        return Ok(headerOnlyStatus);
      }

      const status = unsupportedAccountStatus("OpenAI account status payload was not valid JSON");
      this.cachedAccountStatus = {
        status,
        fetchedAtMs: Date.now(),
      };
      return Ok(status);
    }

    if (!isPlainObject(body)) {
      const headerOnlyStatus = this.statusFromHeaders(response.headers);
      if (headerOnlyStatus) {
        this.cachedAccountStatus = {
          status: headerOnlyStatus,
          fetchedAtMs: Date.now(),
        };
        return Ok(headerOnlyStatus);
      }

      const status = unsupportedAccountStatus(
        "OpenAI account status payload format is unsupported"
      );
      this.cachedAccountStatus = {
        status,
        fetchedAtMs: Date.now(),
      };
      return Ok(status);
    }

    const rateLimit = isPlainObject(body.rate_limit) ? body.rate_limit : null;
    const codeReviewRateLimit = isPlainObject(body.code_review_rate_limit)
      ? body.code_review_rate_limit
      : null;

    const bodyPrimaryWindow = parseRateLimitWindow(rateLimit?.primary_window);
    const bodySecondaryWindow = parseRateLimitWindow(
      rateLimit?.secondary_window ?? codeReviewRateLimit?.primary_window
    );
    const bodyCredits = parseCreditsStatus(body.credits);
    const headerStatus = parseCodexHeaderStatus(response.headers);

    const merged = {
      primaryWindow: mergeWindow(headerStatus.primaryWindow, bodyPrimaryWindow),
      secondaryWindow: mergeWindow(headerStatus.secondaryWindow, bodySecondaryWindow),
      credits: mergeCredits(headerStatus.credits, bodyCredits),
    };

    if (!hasAnyAccountStatusSignal(merged)) {
      const status = unsupportedAccountStatus(
        "OpenAI account status payload did not include usage fields"
      );
      this.cachedAccountStatus = {
        status,
        fetchedAtMs: Date.now(),
      };
      return Ok(status);
    }

    const status: CodexOauthAccountStatus = {
      state: "connected",
      source: headerStatus.hasSignal ? "response-headers" : "wham",
      primaryWindow: merged.primaryWindow,
      secondaryWindow: merged.secondaryWindow,
      credits: merged.credits,
      fetchedAtMs: Date.now(),
      message: null,
    };

    this.cachedAccountStatus = {
      status,
      fetchedAtMs: Date.now(),
    };

    return Ok(status);
  }

  updateAccountStatusFromHeaders(headersInit: Headers | HeadersInit): void {
    const headers = new Headers(headersInit);
    const status = this.statusFromHeaders(headers);
    if (!status) {
      return;
    }

    this.cachedAccountStatus = {
      status,
      fetchedAtMs: Date.now(),
    };
  }

  async dispose(): Promise<void> {
    await this.desktopFlows.shutdownAll();

    const deviceIds = [...this.deviceFlows.keys()];
    await Promise.all(deviceIds.map((id) => this.finishDeviceFlow(id, Err("App shutting down"))));

    for (const flow of this.deviceFlows.values()) {
      clearTimeout(flow.timeout);
      if (flow.cleanupTimeout !== null) {
        clearTimeout(flow.cleanupTimeout);
      }
    }

    this.deviceFlows.clear();
  }

  private readStoredAuth(): CodexOauthAuth | null {
    if (this.cachedAuth) {
      return this.cachedAuth;
    }
    const providersConfig = this.config.loadProvidersConfig() ?? {};
    const openaiConfig = providersConfig.openai as Record<string, unknown> | undefined;
    const auth = parseCodexOauthAuth(openaiConfig?.codexOauth);
    this.cachedAuth = auth;
    return auth;
  }

  private async persistAuth(auth: CodexOauthAuth): Promise<Result<void, string>> {
    const result = await this.providerService.setConfigValue("openai", ["codexOauth"], auth);
    // Invalidate cache so the next readStoredAuth() picks up the persisted value from disk.
    // We clear rather than set because setConfigValue may have side-effects (e.g. file-write
    // failures) and we want the next read to be authoritative.
    this.cachedAuth = null;
    this.cachedAccountStatus = null;
    return result;
  }

  private async handleDesktopCallbackAndExchange(input: {
    flowId: string;
    redirectUri: string;
    codeVerifier: string;
    code?: string;
    error?: string;
    errorDescription?: string;
  }): Promise<Result<void, string>> {
    if (input.error) {
      const message = input.errorDescription
        ? `${input.error}: ${input.errorDescription}`
        : input.error;
      return Err(`Codex OAuth error: ${message}`);
    }

    if (!input.code) {
      return Err("Missing OAuth code");
    }

    const tokenResult = await this.exchangeCodeForTokens({
      code: input.code,
      redirectUri: input.redirectUri,
      codeVerifier: input.codeVerifier,
    });
    if (!tokenResult.success) {
      return Err(tokenResult.error);
    }

    const persistResult = await this.persistAuth(tokenResult.data);
    if (!persistResult.success) {
      return Err(persistResult.error);
    }

    log.debug(`[Codex OAuth] Desktop exchange completed (flowId=${input.flowId})`);

    this.windowService?.focusMainWindow();

    return Ok(undefined);
  }

  private async exchangeCodeForTokens(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<Result<CodexOauthAuth, string>> {
    try {
      const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: buildCodexTokenExchangeBody({
          code: input.code,
          redirectUri: input.redirectUri,
          codeVerifier: input.codeVerifier,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const prefix = `Codex OAuth exchange failed (${response.status})`;
        return Err(errorText ? `${prefix}: ${errorText}` : prefix);
      }

      const json = (await response.json()) as unknown;
      if (!isPlainObject(json)) {
        return Err("Codex OAuth exchange returned an invalid JSON payload");
      }

      const accessToken = typeof json.access_token === "string" ? json.access_token : null;
      const refreshToken = typeof json.refresh_token === "string" ? json.refresh_token : null;
      const expiresIn = parseOptionalNumber(json.expires_in);
      const idToken = typeof json.id_token === "string" ? json.id_token : undefined;

      if (!accessToken) {
        return Err("Codex OAuth exchange response missing access_token");
      }

      if (!refreshToken) {
        return Err("Codex OAuth exchange response missing refresh_token");
      }

      if (expiresIn === null) {
        return Err("Codex OAuth exchange response missing expires_in");
      }

      const accountId = extractAccountIdFromTokens({ accessToken, idToken }) ?? undefined;

      return Ok({
        type: "oauth",
        access: accessToken,
        refresh: refreshToken,
        expires: Date.now() + Math.max(0, Math.floor(expiresIn * 1000)),
        accountId,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Codex OAuth exchange failed: ${message}`);
    }
  }

  private async refreshTokens(current: CodexOauthAuth): Promise<Result<CodexOauthAuth, string>> {
    try {
      const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: buildCodexRefreshBody({ refreshToken: current.refresh }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");

        // When the refresh token is invalid/revoked, clear persisted auth so subsequent
        // requests fall back to the existing "not connected" behavior.
        if (isInvalidGrantError(errorText)) {
          log.debug("[Codex OAuth] Refresh token rejected; clearing stored auth");
          const disconnectResult = await this.disconnect();
          if (!disconnectResult.success) {
            log.warn(
              `[Codex OAuth] Failed to clear stored auth after refresh failure: ${disconnectResult.error}`
            );
          }
        }

        const prefix = `Codex OAuth refresh failed (${response.status})`;
        return Err(errorText ? `${prefix}: ${errorText}` : prefix);
      }

      const json = (await response.json()) as unknown;
      if (!isPlainObject(json)) {
        return Err("Codex OAuth refresh returned an invalid JSON payload");
      }

      const accessToken = typeof json.access_token === "string" ? json.access_token : null;
      const refreshToken = typeof json.refresh_token === "string" ? json.refresh_token : null;
      const expiresIn = parseOptionalNumber(json.expires_in);
      const idToken = typeof json.id_token === "string" ? json.id_token : undefined;

      if (!accessToken) {
        return Err("Codex OAuth refresh response missing access_token");
      }

      if (expiresIn === null) {
        return Err("Codex OAuth refresh response missing expires_in");
      }

      const accountId = extractAccountIdFromTokens({ accessToken, idToken }) ?? current.accountId;

      const next: CodexOauthAuth = {
        type: "oauth",
        access: accessToken,
        refresh: refreshToken ?? current.refresh,
        expires: Date.now() + Math.max(0, Math.floor(expiresIn * 1000)),
        accountId,
      };

      const persistResult = await this.persistAuth(next);
      if (!persistResult.success) {
        return Err(persistResult.error);
      }

      return Ok(next);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Codex OAuth refresh failed: ${message}`);
    }
  }

  private statusFromHeaders(headers: Headers): CodexOauthAccountStatus | null {
    const parsed = parseCodexHeaderStatus(headers);
    if (!parsed.hasSignal) {
      return null;
    }

    return {
      state: "connected",
      source: "response-headers",
      primaryWindow: parsed.primaryWindow,
      secondaryWindow: parsed.secondaryWindow,
      credits: parsed.credits,
      fetchedAtMs: Date.now(),
      message: null,
    };
  }

  private async requestDeviceUserCode(): Promise<
    Result<
      {
        deviceAuthId: string;
        userCode: string;
        intervalSeconds: number;
        expiresAtMs: number;
      },
      string
    >
  > {
    try {
      const response = await fetch(CODEX_OAUTH_DEVICE_USERCODE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const prefix = `Codex OAuth device auth request failed (${response.status})`;
        return Err(errorText ? `${prefix}: ${errorText}` : prefix);
      }

      const json = (await response.json()) as unknown;
      if (!isPlainObject(json)) {
        return Err("Codex OAuth device auth response returned an invalid JSON payload");
      }

      const deviceAuthId = typeof json.device_auth_id === "string" ? json.device_auth_id : null;
      const userCode = typeof json.user_code === "string" ? json.user_code : null;
      const interval = parseOptionalNumber(json.interval);
      const expiresIn = parseOptionalNumber(json.expires_in);

      if (!deviceAuthId || !userCode) {
        return Err("Codex OAuth device auth response missing required fields");
      }

      const intervalSeconds = interval !== null ? Math.max(1, Math.floor(interval)) : 5;
      const expiresAtMs =
        expiresIn !== null
          ? Date.now() + Math.max(0, Math.floor(expiresIn * 1000))
          : Date.now() + DEFAULT_DEVICE_TIMEOUT_MS;

      return Ok({ deviceAuthId, userCode, intervalSeconds, expiresAtMs });
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Codex OAuth device auth request failed: ${message}`);
    }
  }

  private async pollDeviceFlow(flowId: string): Promise<void> {
    const flow = this.deviceFlows.get(flowId);
    if (!flow || flow.settled) {
      return;
    }

    const intervalSeconds = flow.intervalSeconds;

    while (Date.now() < flow.expiresAtMs) {
      if (flow.abortController.signal.aborted) {
        await this.finishDeviceFlow(flowId, Err("OAuth flow cancelled"));
        return;
      }

      const attempt = await this.pollDeviceTokenOnce(flow);
      if (attempt.kind === "success") {
        const persistResult = await this.persistAuth(attempt.auth);
        if (!persistResult.success) {
          await this.finishDeviceFlow(flowId, Err(persistResult.error));
          return;
        }

        log.debug(`[Codex OAuth] Device authorization completed (flowId=${flowId})`);
        this.windowService?.focusMainWindow();
        await this.finishDeviceFlow(flowId, Ok(undefined));
        return;
      }

      if (attempt.kind === "fatal") {
        await this.finishDeviceFlow(flowId, Err(attempt.message));
        return;
      }

      try {
        // OpenCode guide: intervalSeconds * 1000 + 3000
        await sleepWithAbort(intervalSeconds * 1000 + 3000, flow.abortController.signal);
      } catch {
        // Abort is handled via cancelDeviceFlow()/finishDeviceFlow().
        return;
      }
    }

    await this.finishDeviceFlow(flowId, Err("Device code expired"));
  }

  private async pollDeviceTokenOnce(
    flow: DeviceFlow
  ): Promise<
    | { kind: "success"; auth: CodexOauthAuth }
    | { kind: "pending" }
    | { kind: "fatal"; message: string }
  > {
    try {
      const response = await fetch(CODEX_OAUTH_DEVICE_TOKEN_POLL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_auth_id: flow.deviceAuthId, user_code: flow.userCode }),
        signal: flow.abortController.signal,
      });

      if (response.status === 403 || response.status === 404) {
        return { kind: "pending" };
      }

      if (response.status !== 200) {
        const errorText = await response.text().catch(() => "");
        const prefix = `Codex OAuth device token poll failed (${response.status})`;
        return { kind: "fatal", message: errorText ? `${prefix}: ${errorText}` : prefix };
      }

      const json = (await response.json().catch(() => null)) as unknown;
      if (!isPlainObject(json)) {
        return { kind: "fatal", message: "Codex OAuth device token poll returned invalid JSON" };
      }

      const authorizationCode =
        typeof json.authorization_code === "string" ? json.authorization_code : null;
      const codeVerifier = typeof json.code_verifier === "string" ? json.code_verifier : null;

      if (!authorizationCode || !codeVerifier) {
        return {
          kind: "fatal",
          message: "Codex OAuth device token poll response missing required fields",
        };
      }

      const tokenResult = await this.exchangeCodeForTokens({
        code: authorizationCode,
        redirectUri: "https://auth.openai.com/deviceauth/callback",
        codeVerifier,
      });

      if (!tokenResult.success) {
        return { kind: "fatal", message: tokenResult.error };
      }

      return { kind: "success", auth: tokenResult.data };
    } catch (error) {
      // Abort is treated as cancellation.
      if (flow.abortController.signal.aborted) {
        return { kind: "fatal", message: "OAuth flow cancelled" };
      }

      const message = getErrorMessage(error);
      return { kind: "fatal", message: `Device authorization failed: ${message}` };
    }
  }

  private finishDeviceFlow(flowId: string, result: Result<void, string>): Promise<void> {
    const flow = this.deviceFlows.get(flowId);
    if (!flow || flow.settled) {
      return Promise.resolve();
    }

    flow.settled = true;
    clearTimeout(flow.timeout);
    flow.abortController.abort();

    try {
      flow.resolveResult(result);
    } finally {
      if (flow.cleanupTimeout !== null) {
        clearTimeout(flow.cleanupTimeout);
      }
      flow.cleanupTimeout = setTimeout(() => {
        this.deviceFlows.delete(flowId);
      }, COMPLETED_FLOW_TTL_MS);
    }

    return Promise.resolve();
  }
}
