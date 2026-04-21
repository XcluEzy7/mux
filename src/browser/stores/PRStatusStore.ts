/**
 * Store for managing GitHub PR status information.
 *
 * Architecture:
 * - Lives outside React lifecycle (stable references)
 * - Detects workspace PR from current branch via `gh pr view`
 * - Caches status with TTL
 * - Refreshes on focus (like GitStatusStore)
 * - Notifies subscribers when status changes
 *
 * PR detection:
 * - Branch-based: Runs `gh pr view` without URL to detect PR for current branch
 */

import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import type { GitHubPRLink, GitHubPRStatus, GitHubPRLinkWithStatus } from "@/common/types/links";
import type { FrontendWorkspaceMetadata, WorkspacePullRequestFeed } from "@/common/types/workspace";
import { createLRUCache } from "@/browser/utils/lruCache";
import {
  canRunPassiveRuntimeCommand,
  onPassiveRuntimeEligible,
  type PassiveRuntimeDeps,
} from "@/browser/utils/runtimeExecutionPolicy";
import { MapStore } from "./MapStore";
import { RefreshController } from "@/browser/utils/RefreshController";
import { useSyncExternalStore } from "react";
import {
  useRuntimeStatusStoreRaw as getRuntimeStatusStore,
  type RuntimeStatusStore,
} from "./RuntimeStatusStore";

// Cache TTL: PR status is refreshed at most every 5 seconds
const STATUS_CACHE_TTL_MS = 5 * 1000;

// How long to wait before retrying after an error
const ERROR_RETRY_DELAY_MS = 5 * 1000;

/**
 * Persisted PR status for localStorage LRU cache.
 * Stores only the essential data needed to display the badge on app restart.
 */
interface PersistedPRStatus {
  prLink: GitHubPRLink;
  status?: GitHubPRStatus;
}

// LRU cache for persisting PR status across app restarts
const prStatusLRU = createLRUCache<PersistedPRStatus>({
  entryPrefix: "prStatus:",
  indexKey: "prStatusIndex",
  maxEntries: 50,
  // No TTL - we refresh on mount anyway, just want instant display
});

/**
 * Workspace PR detection result (from branch, not chat).
 */
interface WorkspacePRCacheEntry {
  /** The detected PR link (null if no PR for this branch) */
  prLink: GitHubPRLink | null;
  /** PR status if available */
  status?: GitHubPRStatus;
  /** Full typed PR watcher payload for details/remediation UIs. */
  feed?: WorkspacePullRequestFeed;
  error?: string;
  fetchedAt: number;
  loading: boolean;
}

function hasSameMergeQueueEntry(
  previousEntry: GitHubPRStatus["mergeQueueEntry"],
  nextEntry: GitHubPRStatus["mergeQueueEntry"]
): boolean {
  if (previousEntry === nextEntry) {
    return true;
  }

  if (previousEntry == null || nextEntry == null) {
    return previousEntry == null && nextEntry == null;
  }

  return previousEntry.state === nextEntry.state && previousEntry.position === nextEntry.position;
}

function hasSameHookSnapshotStatus(
  previousStatus: GitHubPRStatus | undefined,
  nextStatus: GitHubPRStatus | undefined
): boolean {
  if (previousStatus === nextStatus) {
    return true;
  }

  if (previousStatus == null || nextStatus == null) {
    return previousStatus == null && nextStatus == null;
  }

  return (
    previousStatus.state === nextStatus.state &&
    previousStatus.mergeable === nextStatus.mergeable &&
    previousStatus.mergeStateStatus === nextStatus.mergeStateStatus &&
    previousStatus.title === nextStatus.title &&
    previousStatus.isDraft === nextStatus.isDraft &&
    previousStatus.headRefName === nextStatus.headRefName &&
    previousStatus.baseRefName === nextStatus.baseRefName &&
    previousStatus.hasPendingChecks === nextStatus.hasPendingChecks &&
    previousStatus.hasFailedChecks === nextStatus.hasFailedChecks &&
    hasSameMergeQueueEntry(previousStatus.mergeQueueEntry, nextStatus.mergeQueueEntry)
  );
}

/**
 * Store for GitHub PR status. Fetches status via gh CLI and caches results.
 */
export class PRStatusStore {
  private client: RouterClient<AppRouter> | null = null;
  private readonly refreshController: RefreshController;
  private isActive = true;

  // Workspace-based PR detection (keyed by workspaceId)
  private workspacePRSubscriptions = new MapStore<string, WorkspacePRCacheEntry>();
  private workspacePRFeedSubscriptions = new MapStore<string, WorkspacePullRequestFeed | null>();
  private workspacePRCache = new Map<string, WorkspacePRCacheEntry>();
  // Keep hook snapshots instance-scoped so removed workspaces and disposed stores
  // can reclaim entries instead of leaking via module-level state.
  private workspacePRHookCache = new Map<string, GitHubPRLinkWithStatus | null>();
  private runtimeRetryUnsubscribers = new Map<string, () => void>();

  // Track active subscriptions per workspace so we only refresh workspaces that are actually visible.
  private workspaceSubscriptionCounts = new Map<string, number>();
  private workspaceFeedSubscriptionCounts = new Map<string, number>();

  // Like GitStatusStore: batch immediate refreshes triggered by subscriptions.
  private immediateUpdateQueued = false;
  private workspaceMetadata = new Map<string, FrontendWorkspaceMetadata>();
  private readonly runtimeStatusStore: PassiveRuntimeDeps;

  constructor(runtimeStatusStore?: PassiveRuntimeDeps);
  constructor(runtimeStatusStore?: Pick<RuntimeStatusStore, "getStatus">);
  constructor(
    runtimeStatusStore:
      | PassiveRuntimeDeps
      | Pick<RuntimeStatusStore, "getStatus"> = getRuntimeStatusStore()
  ) {
    this.runtimeStatusStore = {
      getStatus: (workspaceId) => runtimeStatusStore.getStatus(workspaceId),
      subscribeKey:
        "subscribeKey" in runtimeStatusStore
          ? (workspaceId, listener) => runtimeStatusStore.subscribeKey(workspaceId, listener)
          : () => () => undefined,
    };
    this.refreshController = new RefreshController({
      onRefresh: () => this.refreshAll(),
      onRefreshError: (failure) => {
        console.error("[PRStatusStore] refresh failed:", failure.errorMessage);
      },
      debounceMs: 5000,
      refreshOnFocus: true,
      focusDebounceMs: 1000,
    });
  }

  setClient(client: RouterClient<AppRouter> | null): void {
    this.client = client;

    if (!client) {
      return;
    }

    // If hooks subscribed before the client was ready, ensure we refresh once it is.
    if (this.workspaceSubscriptionCounts.size > 0 || this.workspaceFeedSubscriptionCounts.size > 0) {
      this.refreshController.requestImmediate();
    }
  }

  syncWorkspaces(metadata: Map<string, FrontendWorkspaceMetadata>): void {
    if (!this.isActive && metadata.size > 0) {
      this.isActive = true;
    }

    this.workspaceMetadata = metadata;

    for (const id of this.workspacePRCache.keys()) {
      if (!metadata.has(id)) {
        this.workspacePRCache.delete(id);
        this.workspacePRHookCache.delete(id);
      }
    }

    for (const [id, unsubscribe] of this.runtimeRetryUnsubscribers) {
      if (!metadata.has(id)) {
        unsubscribe();
        this.runtimeRetryUnsubscribers.delete(id);
      }
    }
    this.refreshController.bindListeners();
    this.refreshController.requestImmediate();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Workspace-based PR detection (primary mode)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to workspace PR changes (branch-based detection).
   *
   * Like GitStatusStore: subscriptions drive refresh. Components should not need to
   * manually "monitor" workspaces.
   */
  subscribeWorkspace = (workspaceId: string, listener: () => void) => {
    const unsubscribe = this.workspacePRSubscriptions.subscribeKey(workspaceId, listener);

    // Track active subscriptions so focus refresh only runs for visible workspaces.
    const current = this.workspaceSubscriptionCounts.get(workspaceId) ?? 0;
    this.workspaceSubscriptionCounts.set(workspaceId, current + 1);

    // Bind focus/visibility listeners once we have any subscribers.
    this.refreshController.bindListeners();

    // Kick an immediate refresh so the UI doesn't wait for the next focus event.
    // Use a microtask to batch multiple subscribe calls in the same render.
    if (!this.immediateUpdateQueued && this.isActive && this.client) {
      this.immediateUpdateQueued = true;
      queueMicrotask(() => {
        this.immediateUpdateQueued = false;
        this.refreshController.requestImmediate();
      });
    }

    return () => {
      unsubscribe();
      const next = (this.workspaceSubscriptionCounts.get(workspaceId) ?? 1) - 1;
      if (next <= 0) {
        this.workspaceSubscriptionCounts.delete(workspaceId);
        this.workspacePRHookCache.delete(workspaceId);
      } else {
        this.workspaceSubscriptionCounts.set(workspaceId, next);
      }
      this.cleanupWorkspaceSubscription(workspaceId);
    };
  };

  subscribeWorkspaceFeed = (workspaceId: string, listener: () => void) => {
    const unsubscribe = this.workspacePRFeedSubscriptions.subscribeKey(workspaceId, listener);

    const current = this.workspaceFeedSubscriptionCounts.get(workspaceId) ?? 0;
    this.workspaceFeedSubscriptionCounts.set(workspaceId, current + 1);

    this.refreshController.bindListeners();

    if (!this.immediateUpdateQueued && this.isActive && this.client) {
      this.immediateUpdateQueued = true;
      queueMicrotask(() => {
        this.immediateUpdateQueued = false;
        this.refreshController.requestImmediate();
      });
    }

    return () => {
      unsubscribe();
      const next = (this.workspaceFeedSubscriptionCounts.get(workspaceId) ?? 1) - 1;
      if (next <= 0) {
        this.workspaceFeedSubscriptionCounts.delete(workspaceId);
      } else {
        this.workspaceFeedSubscriptionCounts.set(workspaceId, next);
      }
      this.cleanupWorkspaceSubscription(workspaceId);
    };
  };

  private cleanupWorkspaceSubscription(workspaceId: string): void {
    const activeSubscriptionCount =
      (this.workspaceSubscriptionCounts.get(workspaceId) ?? 0) +
      (this.workspaceFeedSubscriptionCounts.get(workspaceId) ?? 0);
    if (activeSubscriptionCount > 0) {
      return;
    }

    this.runtimeRetryUnsubscribers.get(workspaceId)?.();
    this.runtimeRetryUnsubscribers.delete(workspaceId);
  }

  /**
   * Get workspace PR detection result.
   * Checks in-memory cache first, then falls back to localStorage for persistence
   * across app restarts.
   */
  getWorkspacePR(workspaceId: string): WorkspacePRCacheEntry | undefined {
    const memCached = this.workspacePRCache.get(workspaceId);
    if (memCached) return memCached;

    // Check localStorage for persisted status (app restart scenario)
    const persisted = prStatusLRU.get(workspaceId);
    if (persisted) {
      // Hydrate memory cache from localStorage, mark as loading to trigger refresh
      // but show the cached value immediately (optimistic UI)
      const entry: WorkspacePRCacheEntry = {
        prLink: persisted.prLink,
        status: persisted.status,
        loading: true,
        fetchedAt: 0,
      };
      this.workspacePRCache.set(workspaceId, entry);
      return entry;
    }

    return undefined;
  }

  /**
   * Build a stable hook snapshot for useWorkspacePR.
   */
  getWorkspacePRHookSnapshot(workspaceId: string): GitHubPRLinkWithStatus | null {
    const cached = this.getWorkspacePR(workspaceId);
    const existing = this.workspacePRHookCache.get(workspaceId);

    if (!cached?.prLink) {
      if (existing === null) {
        return existing;
      }
      this.workspacePRHookCache.set(workspaceId, null);
      return null;
    }

    const statusUnchanged = hasSameHookSnapshotStatus(existing?.status, cached.status);

    if (
      existing?.url === cached.prLink.url &&
      statusUnchanged &&
      existing?.loading === cached.loading &&
      existing?.error === cached.error
    ) {
      return existing;
    }

    const nextSnapshot: GitHubPRLinkWithStatus = {
      ...cached.prLink,
      status: cached.status,
      loading: cached.loading,
      error: cached.error,
    };
    this.workspacePRHookCache.set(workspaceId, nextSnapshot);
    return nextSnapshot;
  }

  getWorkspacePRFeed(workspaceId: string): WorkspacePullRequestFeed | null {
    return this.getWorkspacePR(workspaceId)?.feed ?? null;
  }

  /**
   * Detect PR for workspace's current branch using a lightweight status-only endpoint.
   */
  async detectWorkspacePR(workspaceId: string): Promise<void> {
    if (!this.client || !this.isActive) return;
    const existing = this.workspacePRCache.get(workspaceId);
    this.workspacePRCache.set(workspaceId, {
      prLink: existing?.prLink ?? null,
      status: existing?.status,
      feed: existing?.feed,
      loading: true,
      fetchedAt: Date.now(),
    });
    this.workspacePRSubscriptions.bump(workspaceId);

    try {
      const result = await this.client.workspace.getPullRequestStatus({ workspaceId });
      if (!this.isActive) return;

      if (!result.success) {
        this.workspacePRCache.set(workspaceId, {
          prLink: existing?.prLink ?? null,
          status: existing?.status,
          feed: existing?.feed,
          error: result.error,
          loading: false,
          fetchedAt: Date.now(),
        });
        this.workspacePRSubscriptions.bump(workspaceId);
        return;
      }

      const previousFeed = existing?.feed;
      const nextFeed =
        result.data == null
          ? previousFeed?.pr == null
            ? previousFeed
            : undefined
          : previousFeed?.pr?.url === result.data.url
            ? previousFeed
            : undefined;
      const nextPRLink = result.data
        ? {
            type: "github-pr" as const,
            url: result.data.url,
            owner: result.data.owner,
            repo: result.data.repo,
            number: result.data.number,
            detectedAt: result.data.detectedAt,
            occurrenceCount: result.data.occurrenceCount,
          }
        : null;
      this.workspacePRCache.set(workspaceId, {
        prLink: nextPRLink,
        status: result.data?.status,
        feed: nextFeed,
        loading: false,
        fetchedAt: result.data?.status?.fetchedAt ?? Date.now(),
      });
      if (nextPRLink) {
        prStatusLRU.set(workspaceId, {
          prLink: nextPRLink,
          status: result.data?.status,
        });
      } else {
        prStatusLRU.remove(workspaceId);
      }
      this.workspacePRSubscriptions.bump(workspaceId);
      if (previousFeed !== nextFeed) {
        this.workspacePRFeedSubscriptions.bump(workspaceId);
      }
    } catch (err) {
      if (!this.isActive) return;

      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      this.workspacePRCache.set(workspaceId, {
        prLink: existing?.prLink ?? null,
        status: existing?.status,
        feed: existing?.feed,
        error: errorMessage,
        loading: false,
        fetchedAt: Date.now(),
      });
      this.workspacePRSubscriptions.bump(workspaceId);
    }
  }

  private async detectWorkspaceFeed(workspaceId: string): Promise<void> {
    if (!this.client || !this.isActive) return;

    try {
      const result = await this.client.workspace.getPullRequestFeed({ workspaceId });
      if (!this.isActive || !result.success) {
        return;
      }

      this.applyFeedToCache(workspaceId, result.data);
      this.workspacePRSubscriptions.bump(workspaceId);
      this.workspacePRFeedSubscriptions.bump(workspaceId);
    } catch {
      // Keep the previous detailed feed visible if the enrichment refresh fails.
    }
  }

  private applyFeedToCache(workspaceId: string, feed: WorkspacePullRequestFeed): void {
    if (!feed.pr) {
      this.workspacePRCache.set(workspaceId, {
        prLink: null,
        status: undefined,
        feed,
        loading: false,
        fetchedAt: feed.fetchedAt,
      });
      prStatusLRU.remove(workspaceId);
      return;
    }

    const prLink: GitHubPRLink = {
      type: "github-pr",
      url: feed.pr.url,
      owner: feed.pr.owner,
      repo: feed.pr.repo,
      number: feed.pr.number,
      detectedAt: feed.pr.detectedAt,
      occurrenceCount: feed.pr.occurrenceCount,
    };
    const status = feed.pr.status;

    this.workspacePRCache.set(workspaceId, {
      prLink,
      status,
      feed,
      loading: false,
      fetchedAt: feed.fetchedAt,
    });
    prStatusLRU.set(workspaceId, { prLink, status });
  }

  private shouldFetchWorkspace(entry: WorkspacePRCacheEntry | undefined, now: number): boolean {
    if (!entry) return true;
    // Allow refresh if entry was hydrated from localStorage (fetchedAt === 0)
    // but is marked loading - this means we have stale cached data and need fresh data.
    if (entry.loading && entry.fetchedAt !== 0) return false;

    if (entry.error) {
      return now - entry.fetchedAt > ERROR_RETRY_DELAY_MS;
    }

    return now - entry.fetchedAt > STATUS_CACHE_TTL_MS;
  }

  private shouldFetchWorkspaceFeed(entry: WorkspacePRCacheEntry | undefined, now: number): boolean {
    if (!entry?.feed) return true;
    return now - entry.feed.fetchedAt > STATUS_CACHE_TTL_MS;
  }

  /**
   * Refresh PR status for all subscribed workspaces.
   * Called via RefreshController (focus + debounced refresh).
   */
  private async refreshAll(): Promise<void> {
    if (!this.client || !this.isActive) return;

    const workspaceIds = Array.from(
      new Set([
        ...this.workspaceSubscriptionCounts.keys(),
        ...this.workspaceFeedSubscriptionCounts.keys(),
      ])
    );
    if (workspaceIds.length === 0) {
      return;
    }

    const now = Date.now();
    const refreshes: Array<Promise<void>> = [];

    for (const workspaceId of workspaceIds) {
      const cached = this.workspacePRCache.get(workspaceId);
      const statusSubscribed = this.workspaceSubscriptionCounts.has(workspaceId);
      const feedSubscribed = this.workspaceFeedSubscriptionCounts.has(workspaceId);
      const needsFeedRefresh = feedSubscribed && this.shouldFetchWorkspaceFeed(cached, now);
      const needsStatusRefresh =
        statusSubscribed && !needsFeedRefresh && this.shouldFetchWorkspace(cached, now);

      if (!needsFeedRefresh && !needsStatusRefresh) {
        continue;
      }

      // Skip passive PR refresh for devcontainer workspaces whose runtime is
      // not already running, to avoid waking stopped containers.
      const metadata = this.workspaceMetadata.get(workspaceId);
      if (
        metadata &&
        !canRunPassiveRuntimeCommand(
          metadata.runtimeConfig,
          this.runtimeStatusStore.getStatus(workspaceId)
        )
      ) {
        if (!this.runtimeRetryUnsubscribers.has(workspaceId)) {
          let firedSynchronously = false;
          const unsubscribe = onPassiveRuntimeEligible(
            workspaceId,
            metadata.runtimeConfig,
            this.runtimeStatusStore,
            () => {
              firedSynchronously = true;
              this.runtimeRetryUnsubscribers.delete(workspaceId);
              this.workspacePRCache.delete(workspaceId);
              this.refreshController.requestImmediate();
            }
          );
          if (!firedSynchronously) {
            this.runtimeRetryUnsubscribers.set(workspaceId, unsubscribe);
          }
        }
        continue;
      }

      refreshes.push(
        needsFeedRefresh ? this.detectWorkspaceFeed(workspaceId) : this.detectWorkspacePR(workspaceId)
      );
    }

    await Promise.all(refreshes);
  }

  /**
   * Dispose the store.
   */
  dispose(): void {
    this.isActive = false;
    for (const unsubscribe of this.runtimeRetryUnsubscribers.values()) {
      unsubscribe();
    }
    this.runtimeRetryUnsubscribers.clear();
    this.workspacePRCache.clear();
    this.workspacePRHookCache.clear();
    this.refreshController.dispose();
  }
}

// Singleton instance
let storeInstance: PRStatusStore | null = null;

export function getPRStatusStoreInstance(): PRStatusStore {
  storeInstance ??= new PRStatusStore();
  return storeInstance;
}

// ─────────────────────────────────────────────────────────────────────────────
// React hooks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hook to get the full typed PR watcher feed for a workspace.
 * Returns null before the first successful fetch for that workspace.
 */
export function useWorkspacePullRequestFeed(workspaceId: string): WorkspacePullRequestFeed | null {
  const store = getPRStatusStoreInstance();

  return useSyncExternalStore(
    (listener) => store.subscribeWorkspaceFeed(workspaceId, listener),
    () => store.getWorkspacePRFeed(workspaceId)
  );
}

/**
 * Hook to get PR for a workspace (branch-based detection).
 * Returns the detected PR with status, or null if no PR for this branch.
 */
export function useWorkspacePR(workspaceId: string): GitHubPRLinkWithStatus | null {
  const store = getPRStatusStoreInstance();

  return useSyncExternalStore(
    (listener) => store.subscribeWorkspace(workspaceId, listener),
    () => store.getWorkspacePRHookSnapshot(workspaceId)
  );
}
