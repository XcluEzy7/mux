import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import type { CodexOauthAccountStatus } from "./useCodexOauthAccountStatus";

interface CodexAccountStatusApi {
  codexOauth: {
    getAccountStatus: () => Promise<
      { success: true; data: CodexOauthAccountStatus } | { success: false; error: string }
    >;
  };
}

let apiMock: CodexAccountStatusApi | null = null;

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: apiMock }),
}));

import {
  formatCodexOauthUsedPercent,
  isCodexOauthAccountLimited,
  useCodexOauthAccountStatus,
} from "./useCodexOauthAccountStatus";

function createConnectedStatus(
  overrides: Partial<CodexOauthAccountStatus> = {}
): CodexOauthAccountStatus {
  return {
    state: "connected",
    source: "wham",
    primaryWindow: { usedPercent: 24, windowMinutes: 300, resetsAt: "2026-04-18T00:00:00.000Z" },
    secondaryWindow: {
      usedPercent: 10,
      windowMinutes: 10080,
      resetsAt: "2026-04-18T00:00:00.000Z",
    },
    credits: { hasCredits: true, unlimited: false, balance: 42 },
    fetchedAtMs: 1_713_398_400_000,
    message: null,
    ...overrides,
  };
}

describe("useCodexOauthAccountStatus", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    apiMock = null;
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("refresh stores account data on success", async () => {
    const status = createConnectedStatus();
    apiMock = {
      codexOauth: {
        getAccountStatus: () => Promise.resolve({ success: true, data: status }),
      },
    };

    const { result } = renderHook(() => useCodexOauthAccountStatus());

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.data).toEqual(status);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  test("refresh keeps stale data when request fails", async () => {
    const status = createConnectedStatus();
    const getAccountStatus = mock<CodexAccountStatusApi["codexOauth"]["getAccountStatus"]>(() =>
      Promise.resolve({ success: true, data: status })
    );

    apiMock = {
      codexOauth: {
        getAccountStatus,
      },
    };

    const { result } = renderHook(() => useCodexOauthAccountStatus());

    await act(async () => {
      await result.current.refresh();
    });

    getAccountStatus.mockImplementation(() =>
      Promise.resolve({ success: false, error: "Request failed" })
    );

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.data).toEqual(status);
    expect(result.current.error).toBe("Request failed");
    expect(result.current.isLoading).toBe(false);
  });
});

describe("isCodexOauthAccountLimited", () => {
  test("returns true when credits are depleted", () => {
    expect(
      isCodexOauthAccountLimited(
        createConnectedStatus({ credits: { hasCredits: false, unlimited: false, balance: 0 } })
      )
    ).toBe(true);
  });

  test("returns true when any usage window reaches 100%", () => {
    expect(
      isCodexOauthAccountLimited(
        createConnectedStatus({
          primaryWindow: { usedPercent: 100, windowMinutes: 300, resetsAt: null },
        })
      )
    ).toBe(true);
  });

  test("returns false for disconnected status", () => {
    expect(isCodexOauthAccountLimited(createConnectedStatus({ state: "disconnected" }))).toBe(
      false
    );
  });
});

describe("formatCodexOauthUsedPercent", () => {
  test("formats nullish values as em dash", () => {
    expect(formatCodexOauthUsedPercent(null)).toBe("—");
    expect(formatCodexOauthUsedPercent(undefined)).toBe("—");
  });

  test("rounds finite percentages", () => {
    expect(formatCodexOauthUsedPercent(61.4)).toBe("61%");
    expect(formatCodexOauthUsedPercent(61.6)).toBe("62%");
  });
});
