import { describe, expect, it, mock } from "bun:test";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { FrontendWorkspaceMetadata, WorkspacePullRequestFeed } from "@/common/types/workspace";
import type { RuntimeStatus } from "./RuntimeStatusStore";
import { PRStatusStore } from "./PRStatusStore";

const DEVCONTAINER_RUNTIME = {
  type: "devcontainer" as const,
  configPath: ".devcontainer/devcontainer.json",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createWorkspaceMetadata(
  workspaceId: string,
  runtimeConfig: FrontendWorkspaceMetadata["runtimeConfig"]
): FrontendWorkspaceMetadata {
  return {
    id: workspaceId,
    name: workspaceId,
    projectName: "mux",
    projectPath: "/tmp/mux",
    namedWorkspacePath: `/tmp/mux/${workspaceId}`,
    runtimeConfig,
  };
}

async function waitUntil(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for passive PR refresh");
    }
    await sleep(10);
  }
}

function createRuntimeStatusStoreMock(initialStatus: RuntimeStatus | null) {
  let runtimeStatus = initialStatus;
  const subscribeKeyListeners = new Map<string, Set<() => void>>();

  return {
    runtimeStatusStore: {
      getStatus: (_workspaceId: string) => runtimeStatus,
      subscribeKey: (workspaceId: string, listener: () => void) => {
        let listeners = subscribeKeyListeners.get(workspaceId);
        if (!listeners) {
          listeners = new Set();
          subscribeKeyListeners.set(workspaceId, listeners);
        }
        listeners.add(listener);
        return () => {
          listeners?.delete(listener);
        };
      },
    },
    setStatus: (nextStatus: RuntimeStatus | null) => {
      runtimeStatus = nextStatus;
    },
    emit(workspaceId: string) {
      for (const listener of Array.from(subscribeKeyListeners.get(workspaceId) ?? [])) {
        listener();
      }
    },
    getListenerCount(workspaceId: string) {
      return subscribeKeyListeners.get(workspaceId)?.size ?? 0;
    },
  };
}

async function runPassiveRefreshScenario(
  metadata: FrontendWorkspaceMetadata,
  runtimeStatus: RuntimeStatus | null,
  shouldRun: boolean
): Promise<number> {
  const getPullRequestFeedBatch = mock(() => {
    // Return a top-level failure so detectWorkspacePR exits quickly.
    // These tests only care whether passive refresh attempted the endpoint call.
    return Promise.resolve({
      [metadata.id]: { success: false as const, error: "gh unavailable" },
    });
  });

  const store = new PRStatusStore({
    getStatus: () => runtimeStatus,
  });

  try {
    store.setClient({
      workspace: {
        getPullRequestFeedBatch,
      },
    } as unknown as Parameters<PRStatusStore["setClient"]>[0]);

    store.syncWorkspaces(new Map([[metadata.id, metadata]]));
    await sleep(0);
    store.subscribeWorkspace(metadata.id, () => undefined);

    if (shouldRun) {
      await waitUntil(() => getPullRequestFeedBatch.mock.calls.length > 0);
    } else {
      await sleep(100);
    }

    return getPullRequestFeedBatch.mock.calls.length;
  } finally {
    store.dispose();
  }
}

describe("passive refresh runtime gating", () => {
  it("skips passive PR refresh for stopped devcontainer", async () => {
    const callCount = await runPassiveRefreshScenario(
      createWorkspaceMetadata("dc-stopped", DEVCONTAINER_RUNTIME),
      "stopped",
      false
    );

    expect(callCount).toBe(0);
  });

  it("skips passive PR refresh for unknown devcontainer", async () => {
    const callCount = await runPassiveRefreshScenario(
      createWorkspaceMetadata("dc-unknown", DEVCONTAINER_RUNTIME),
      "unknown",
      false
    );

    expect(callCount).toBe(0);
  });

  it("runs passive PR refresh for running devcontainer", async () => {
    const callCount = await runPassiveRefreshScenario(
      createWorkspaceMetadata("dc-running", DEVCONTAINER_RUNTIME),
      "running",
      true
    );

    expect(callCount).toBe(1);
  });

  it("retries PR refresh when devcontainer runtime transitions from null to running", async () => {
    const metadata = createWorkspaceMetadata("dc-retry", DEVCONTAINER_RUNTIME);
    const runtimeStatusStore = createRuntimeStatusStoreMock(null);
    const getPullRequestFeedBatch = mock(() => {
      return Promise.resolve({
        [metadata.id]: { success: false as const, error: "gh unavailable" },
      });
    });
    const store = new PRStatusStore(runtimeStatusStore.runtimeStatusStore);

    try {
      store.setClient({
        workspace: {
          getPullRequestFeedBatch,
        },
      } as unknown as Parameters<PRStatusStore["setClient"]>[0]);

      store.syncWorkspaces(new Map([[metadata.id, metadata]]));
      await sleep(0);
      store.subscribeWorkspace(metadata.id, () => undefined);

      await waitUntil(() => runtimeStatusStore.getListenerCount(metadata.id) > 0);
      expect(getPullRequestFeedBatch.mock.calls.length).toBe(0);

      runtimeStatusStore.setStatus("running");
      runtimeStatusStore.emit(metadata.id);

      await waitUntil(() => getPullRequestFeedBatch.mock.calls.length > 0);
      expect(getPullRequestFeedBatch.mock.calls.length).toBe(1);
    } finally {
      store.dispose();
    }
  });

  it("does not retry PR refresh when devcontainer runtime stays stopped", async () => {
    const metadata = createWorkspaceMetadata("dc-stays-stopped", DEVCONTAINER_RUNTIME);
    const runtimeStatusStore = createRuntimeStatusStoreMock(null);
    const getPullRequestFeedBatch = mock(() => {
      return Promise.resolve({
        [metadata.id]: { success: false as const, error: "gh unavailable" },
      });
    });
    const store = new PRStatusStore(runtimeStatusStore.runtimeStatusStore);

    try {
      store.setClient({
        workspace: {
          getPullRequestFeedBatch,
        },
      } as unknown as Parameters<PRStatusStore["setClient"]>[0]);

      store.syncWorkspaces(new Map([[metadata.id, metadata]]));
      await sleep(0);
      store.subscribeWorkspace(metadata.id, () => undefined);

      await waitUntil(() => runtimeStatusStore.getListenerCount(metadata.id) > 0);
      expect(getPullRequestFeedBatch.mock.calls.length).toBe(0);

      runtimeStatusStore.setStatus("stopped");
      runtimeStatusStore.emit(metadata.id);
      await sleep(100);

      expect(getPullRequestFeedBatch.mock.calls.length).toBe(0);
    } finally {
      store.dispose();
    }
  });

  it("runs passive PR refresh for non-devcontainer workspace", async () => {
    const callCount = await runPassiveRefreshScenario(
      createWorkspaceMetadata("wt-1", DEFAULT_RUNTIME_CONFIG),
      "unknown",
      true
    );

    expect(callCount).toBe(1);
  });
});

describe("PR feed caching", () => {
  function makeFeed(workspaceId: string): WorkspacePullRequestFeed {
    const fetchedAt = Date.now();
    return {
      workspaceId,
      pr: {
        type: "github-pr",
        url: "https://github.com/coder/mux/pull/42",
        owner: "coder",
        repo: "mux",
        number: 42,
        detectedAt: fetchedAt,
        occurrenceCount: 1,
        status: {
          state: "OPEN",
          mergeable: "MERGEABLE",
          mergeStateStatus: "BLOCKED",
          title: "Add PR watcher details UI",
          isDraft: false,
          headRefName: "feature/pr-feed",
          baseRefName: "main",
          hasPendingChecks: true,
          hasFailedChecks: false,
          fetchedAt,
        },
      },
      reviewDecision: "REVIEW_REQUIRED",
      checksSummary: {
        hasPendingChecks: true,
        hasFailedChecks: false,
      },
      reviewers: [
        {
          login: "codex",
          isBot: true,
          category: "codex",
        },
      ],
      threads: [
        {
          id: "thread-1",
          isResolved: false,
          isOutdated: false,
          comments: [
            {
              id: "comment-1",
              url: "https://github.com/coder/mux/pull/42#discussion_r1",
              body: "Please add test coverage for this edge case.",
              path: "src/browser/stores/PRStatusStore.ts",
              line: 123,
              createdAt: new Date(fetchedAt).toISOString(),
              replyToId: null,
              author: {
                login: "coderabbitai",
                isBot: true,
                category: "coderabbit",
              },
            },
          ],
        },
      ],
      fetchedAt,
    };
  }

  it("stores the full workspace PR feed when fetch succeeds", async () => {
    const workspaceId = "ws-feed";
    const feed = makeFeed(workspaceId);
    const getPullRequestFeedBatch = mock(() =>
      Promise.resolve({ [workspaceId]: { success: true as const, data: feed } })
    );
    const store = new PRStatusStore({
      getStatus: () => "running",
    });

    try {
      store.setClient({
        workspace: {
          getPullRequestFeedBatch,
        },
      } as unknown as Parameters<PRStatusStore["setClient"]>[0]);

      store.syncWorkspaces(
        new Map([[workspaceId, createWorkspaceMetadata(workspaceId, DEFAULT_RUNTIME_CONFIG)]])
      );
      await sleep(0);
      store.subscribeWorkspace(workspaceId, () => undefined);

      await waitUntil(() => Boolean(store.getWorkspacePR(workspaceId)?.feed));

      const cached = store.getWorkspacePR(workspaceId);
      expect(cached?.feed).toEqual(feed);
      expect(cached?.prLink?.number).toBe(42);
      expect(cached?.status?.title).toBe("Add PR watcher details UI");
      expect(getPullRequestFeedBatch.mock.calls.length).toBe(1);
    } finally {
      store.dispose();
    }
  });

  it("retains the previous feed when refresh fails", async () => {
    const workspaceId = "ws-feed-error";
    const feed = makeFeed(workspaceId);
    const getPullRequestFeedBatch = mock(() =>
      Promise.resolve({ [workspaceId]: { success: true as const, data: feed } })
    );
    const store = new PRStatusStore({
      getStatus: () => "running",
    });

    try {
      store.setClient({
        workspace: {
          getPullRequestFeedBatch,
        },
      } as unknown as Parameters<PRStatusStore["setClient"]>[0]);

      store.syncWorkspaces(
        new Map([[workspaceId, createWorkspaceMetadata(workspaceId, DEFAULT_RUNTIME_CONFIG)]])
      );
      await sleep(0);
      store.subscribeWorkspace(workspaceId, () => undefined);
      await waitUntil(() => Boolean(store.getWorkspacePR(workspaceId)?.feed));

      getPullRequestFeedBatch.mockImplementationOnce(() => Promise.reject(new Error("network error")));

      await (
        store as unknown as { detectWorkspacePR(id: string): Promise<void> }
      ).detectWorkspacePR(workspaceId);

      const cached = store.getWorkspacePR(workspaceId);
      expect(cached?.error).toBe("network error");
      expect(cached?.feed).toEqual(feed);
    } finally {
      store.dispose();
    }
  });

  it("refreshes the hook snapshot when status title or merge queue changes", async () => {
    const workspaceId = "ws-feed-status-refresh";
    const initialFeed = makeFeed(workspaceId);
    const refreshedFeed = makeFeed(workspaceId);
    refreshedFeed.pr = {
      ...refreshedFeed.pr!,
      status: {
        ...refreshedFeed.pr!.status!,
        title: "Add PR watcher details UI v2",
        baseRefName: "dev",
        mergeQueueEntry: {
          state: "QUEUED",
          position: 2,
        },
      },
    };

    const getPullRequestFeedBatch = mock(() =>
      Promise.resolve({ [workspaceId]: { success: true as const, data: initialFeed } })
    );
    const store = new PRStatusStore({
      getStatus: () => "running",
    });

    try {
      store.setClient({
        workspace: {
          getPullRequestFeedBatch,
        },
      } as unknown as Parameters<PRStatusStore["setClient"]>[0]);

      store.syncWorkspaces(
        new Map([[workspaceId, createWorkspaceMetadata(workspaceId, DEFAULT_RUNTIME_CONFIG)]])
      );
      await sleep(0);
      store.subscribeWorkspace(workspaceId, () => undefined);
      await waitUntil(() => Boolean(store.getWorkspacePR(workspaceId)?.feed));

      const initialSnapshot = store.getWorkspacePRHookSnapshot(workspaceId);
      expect(initialSnapshot?.status?.title).toBe("Add PR watcher details UI");

      getPullRequestFeedBatch.mockImplementationOnce(() =>
        Promise.resolve({ [workspaceId]: { success: true as const, data: refreshedFeed } })
      );

      await (
        store as unknown as { detectWorkspacePR(id: string): Promise<void> }
      ).detectWorkspacePR(workspaceId);

      const refreshedSnapshot = store.getWorkspacePRHookSnapshot(workspaceId);
      expect(refreshedSnapshot).not.toBe(initialSnapshot);
      expect(refreshedSnapshot?.status?.title).toBe("Add PR watcher details UI v2");
      expect(refreshedSnapshot?.status?.baseRefName).toBe("dev");
      expect(refreshedSnapshot?.status?.mergeQueueEntry).toEqual({
        state: "QUEUED",
        position: 2,
      });
    } finally {
      store.dispose();
    }
  });

  it("refreshes multiple subscribed workspaces with one batch request", async () => {
    const workspaceA = "ws-feed-a";
    const workspaceB = "ws-feed-b";
    const getPullRequestFeedBatch = mock((input: { workspaceIds: string[] }) =>
      Promise.resolve(
        Object.fromEntries(
          input.workspaceIds.map((workspaceId) => [
            workspaceId,
            { success: true as const, data: makeFeed(workspaceId) },
          ])
        )
      )
    );
    const store = new PRStatusStore({
      getStatus: () => "running",
    });

    try {
      store.setClient({
        workspace: {
          getPullRequestFeedBatch,
        },
      } as unknown as Parameters<PRStatusStore["setClient"]>[0]);

      store.syncWorkspaces(
        new Map([
          [workspaceA, createWorkspaceMetadata(workspaceA, DEFAULT_RUNTIME_CONFIG)],
          [workspaceB, createWorkspaceMetadata(workspaceB, DEFAULT_RUNTIME_CONFIG)],
        ])
      );
      await sleep(0);
      store.subscribeWorkspace(workspaceA, () => undefined);
      store.subscribeWorkspace(workspaceB, () => undefined);

      await waitUntil(
        () =>
          Boolean(store.getWorkspacePR(workspaceA)?.feed) &&
          Boolean(store.getWorkspacePR(workspaceB)?.feed)
      );

      expect(getPullRequestFeedBatch.mock.calls.length).toBe(1);
      expect(getPullRequestFeedBatch.mock.calls[0]?.[0]).toEqual({
        workspaceIds: [workspaceA, workspaceB],
      });
    } finally {
      store.dispose();
    }
  });
});
