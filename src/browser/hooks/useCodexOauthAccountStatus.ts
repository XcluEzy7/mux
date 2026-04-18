import { useCallback, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { getErrorMessage } from "@/common/utils/errors";

export type CodexOauthAccountStatusState = "connected" | "disconnected" | "unsupported";

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
  source: "wham" | "response-headers" | null;
  primaryWindow: CodexOauthRateLimitWindow;
  secondaryWindow: CodexOauthRateLimitWindow;
  credits: CodexOauthCreditsStatus;
  fetchedAtMs: number | null;
  message: string | null;
}

/**
 * A connected account is considered at limit when credits are depleted or
 * one of the reported usage windows reaches 100%.
 */
export function isCodexOauthAccountLimited(
  status: CodexOauthAccountStatus | null | undefined
): boolean {
  if (status?.state !== "connected") {
    return false;
  }

  if (status.credits.unlimited === true) {
    return false;
  }

  if (status.credits.hasCredits === false) {
    return true;
  }

  return (
    (status.primaryWindow.usedPercent ?? 0) >= 100 ||
    (status.secondaryWindow.usedPercent ?? 0) >= 100
  );
}

export function formatCodexOauthUsedPercent(usedPercent: number | null | undefined): string {
  if (usedPercent == null || !Number.isFinite(usedPercent)) {
    return "—";
  }

  return `${Math.round(usedPercent)}%`;
}

export function useCodexOauthAccountStatus() {
  const { api } = useAPI();
  const [data, setData] = useState<CodexOauthAccountStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async (): Promise<CodexOauthAccountStatus | null> => {
    if (!api) {
      setData(null);
      setError(null);
      return null;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await api.codexOauth.getAccountStatus();
      if (result.success) {
        setData(result.data);
        return result.data;
      }

      setError(result.error);
      return null;
    } catch (err) {
      setError(getErrorMessage(err));
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [api]);

  return { data, error, isLoading, refresh };
}
