import { useCallback, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { getErrorMessage } from "@/common/utils/errors";

export interface SyntheticQuota {
  limit: number | null;
  requests: number | null;
  renewsAt: string | null;
}

/** Format remaining requests as "N/M" or "Pay-as-you-go" */
export function formatSyntheticQuota(quota: SyntheticQuota | null | undefined): string {
  if (!quota?.limit || !quota?.requests) {
    return "Pay-as-you-go";
  }
  const remaining = quota.limit - quota.requests;
  return `${remaining}/${quota.limit}`;
}

/** Relative time string for renewal date, e.g. "in 23 days" */
export function formatSyntheticRenewal(renewsAt: string | null | undefined): string {
  if (!renewsAt) return "";
  const diff = new Date(renewsAt).getTime() - Date.now();
  if (diff <= 0) return "resets soon";
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
  if (days > 1) return `resets in ${days} days`;
  const hours = Math.ceil(diff / (1000 * 60 * 60));
  if (hours > 1) return `resets in ${hours} hours`;
  const mins = Math.ceil(diff / (1000 * 60));
  return `resets in ${mins} minutes`;
}

export function useSyntheticQuota() {
  const { api } = useAPI();
  const [data, setData] = useState<SyntheticQuota | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async (): Promise<SyntheticQuota | null> => {
    if (!api) return null;
    setIsLoading(true);
    setError(null);
    try {
      const result = await api.synthetic.getQuota();
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
