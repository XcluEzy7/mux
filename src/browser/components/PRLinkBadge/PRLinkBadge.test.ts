import { describe, expect, it } from "bun:test";

import type { GitHubPRLinkWithStatus, GitHubPRStatus } from "@/common/types/links";
import {
  buildRemediationStartMessage,
  getReviewerCategoryLabel,
  getStatusColorClass,
  getTooltipContent,
} from "./PRLinkBadge";

function makePRLink(statusOverrides: Partial<GitHubPRStatus> = {}): GitHubPRLinkWithStatus {
  return {
    type: "github-pr",
    url: "https://github.com/coder/mux/pull/1",
    owner: "coder",
    repo: "mux",
    number: 1,
    detectedAt: 0,
    occurrenceCount: 1,
    status: {
      state: "OPEN",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      title: "Test PR",
      isDraft: false,
      headRefName: "feature",
      baseRefName: "main",
      fetchedAt: Date.now(),
      ...statusOverrides,
    },
  };
}

describe("getStatusColorClass", () => {
  it("returns warning when PR is in merge queue", () => {
    const pr = makePRLink({ mergeQueueEntry: { state: "QUEUED", position: 0 } });

    expect(getStatusColorClass(pr)).toBe("text-warning");
  });

  it("keeps draft color priority even when merge queue data exists", () => {
    const pr = makePRLink({
      isDraft: true,
      mergeQueueEntry: { state: "QUEUED", position: 0 },
    });

    expect(getStatusColorClass(pr)).toBe("text-muted");
  });

  it("uses non-queue status colors when merge queue entry is null", () => {
    const pr = makePRLink({ mergeStateStatus: "CLEAN", mergeQueueEntry: null });

    expect(getStatusColorClass(pr)).toBe("text-success");
  });
});

describe("getTooltipContent", () => {
  it("shows 1-indexed queue position for merge queue entries", () => {
    const pr = makePRLink({ mergeQueueEntry: { state: "QUEUED", position: 0 } });

    expect(getTooltipContent(pr)).toContain("In merge queue (position 1)");
  });

  it("shows merge queue text without position when queue position is unavailable", () => {
    const pr = makePRLink({ mergeQueueEntry: { state: "QUEUED", position: null } });

    const tooltip = getTooltipContent(pr);
    expect(tooltip).toContain("In merge queue");
    expect(tooltip).not.toContain("position");
  });

  it("does not mention merge queue when entry is absent", () => {
    const pr = makePRLink({ mergeStateStatus: "CLEAN" });

    expect(getTooltipContent(pr)).not.toContain("merge queue");
  });
});

describe("reviewer attribution and remediation message", () => {
  it("maps reviewer categories to user-facing labels", () => {
    expect(getReviewerCategoryLabel("codex")).toBe("Codex");
    expect(getReviewerCategoryLabel("coderabbit")).toBe("CodeRabbit");
    expect(getReviewerCategoryLabel("greptile")).toBe("Greptile");
    expect(getReviewerCategoryLabel("human")).toBe("Human");
    expect(getReviewerCategoryLabel("unknown-bot")).toBe("Unknown bot");
  });

  it("builds remediation text with reviewer attribution and unresolved findings", () => {
    const message = buildRemediationStartMessage({
      workspaceId: "ws-1",
      pr: makePRLink(),
      reviewDecision: "CHANGES_REQUESTED",
      checksSummary: {
        hasPendingChecks: false,
        hasFailedChecks: true,
      },
      reviewers: [
        { login: "codex", isBot: true, category: "codex" },
        { login: "alice", isBot: false, category: "human" },
      ],
      threads: [
        {
          id: "thread-1",
          isResolved: false,
          isOutdated: false,
          comments: [
            {
              id: "comment-1",
              url: null,
              body: "Please guard this null case.",
              path: "src/browser/components/PRLinkBadge/PRLinkBadge.tsx",
              line: 50,
              createdAt: null,
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
      fetchedAt: Date.now(),
    });

    expect(message).toContain("Review decision: Changes requested");
    expect(message).toContain("- codex (Codex)");
    expect(message).toContain("- alice (Human)");
    expect(message).toContain("[coderabbitai (CodeRabbit)]");
    expect(message).toContain("src/browser/components/PRLinkBadge/PRLinkBadge.tsx:50");
    expect(message).toContain("Please guard this null case.");
  });
});
