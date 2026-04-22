import { useCallback, useEffect, useState } from "react";
import { useORPC } from "../orpc/react";
import { buildGitDiffCommand } from "../utils/git/gitCommands";
import { parseNumstat, type FileStats } from "../utils/git/numstatParser";
import type { ReviewActionBadgeParams } from "../types/review";

/**
 * Hook to fetch the count of changed files for workspace action sheet badges.
 * Uses the same git-diff semantics as GitReviewScreen by default (diffBase="main",
 * includeUncommitted=true), but accepts override params so callers can use
 * different diff bases or uncommitted settings.
 *
 * @param workspaceId - The workspace ID to fetch changes for
 * @param params - Optional badge params (diffBase, includeUncommitted)
 * @returns changeCount - Number of changed files, or undefined if loading/empty/error
 */
export function useReviewChangeCount(
  workspaceId: string,
  params?: ReviewActionBadgeParams
): number | undefined {
  const client = useORPC();
  const [changeCount, setChangeCount] = useState<number | undefined>(undefined);

  // Default to review defaults; caller may override
  const diffBase = params?.diffBase ?? "main";
  const includeUncommitted = params?.includeUncommitted ?? true;

  const loadChangeCount = useCallback(async () => {
    if (!workspaceId) {
      setChangeCount(undefined);
      return;
    }

    try {
      const numstatCommand = buildGitDiffCommand(diffBase, includeUncommitted, "", "numstat");
      const result = await client.workspace.executeBash({
        workspaceId,
        script: numstatCommand,
        options: { timeout_secs: 30 },
      });

      if (!result.success || !result.data?.success) {
        // Silently fail - badge just won't show
        setChangeCount(undefined);
        return;
      }

      const fileStats: FileStats[] = parseNumstat(result.data.output ?? "");
      const count = fileStats.length;

      // Only show badge when there are actual changes
      setChangeCount(count > 0 ? count : undefined);
    } catch {
      // Silently fail - badge won't show
      setChangeCount(undefined);
    }
  }, [workspaceId, client, diffBase, includeUncommitted]);

  useEffect(() => {
    void loadChangeCount();
  }, [loadChangeCount]);

  return changeCount;
}
