/**
 * PR link badge component for displaying GitHub PR status in header.
 */

import {
  AlertCircle,
  Check,
  CircleDot,
  ExternalLink,
  GitPullRequest,
  Loader2,
  Rocket,
  X,
} from "lucide-react";
import { useState } from "react";
import type {
  GitHubPRLinkWithStatus,
  PullRequestReviewComment,
  PullRequestReviewThread,
  WorkspacePullRequestFeed,
} from "@/common/types/links";
import { cn } from "@/common/lib/utils";
import { Button } from "../Button/Button";
import { Popover, PopoverContent, PopoverTrigger } from "../Popover/Popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "../Tooltip/Tooltip";

interface PRLinkBadgeProps {
  prLink: GitHubPRLinkWithStatus;
  feed?: WorkspacePullRequestFeed | null;
  onPushToFix?: (startMessage: string) => Promise<void>;
}

/**
 * Get status color class based on PR merge state.
 * When refreshing with cached status, we keep the existing color rather than fading to muted.
 */
export function getStatusColorClass(prLink: GitHubPRLinkWithStatus): string {
  // When loading without cached status, show muted
  if (prLink.loading && !prLink.status) return "text-muted";
  if (prLink.error) return "text-danger-soft";
  if (!prLink.status) return "text-muted";

  const { state, mergeable, mergeStateStatus, isDraft, hasFailedChecks, hasPendingChecks } =
    prLink.status;

  if (state === "MERGED") return "text-purple-500";
  if (state === "CLOSED") return "text-danger-soft";
  if (isDraft || mergeStateStatus === "DRAFT") return "text-muted";

  if (prLink.status.mergeQueueEntry != null) return "text-warning";

  if (mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY") return "text-danger-soft";

  if (mergeStateStatus === "CLEAN") return "text-success";
  if (mergeStateStatus === "BEHIND") return "text-warning";

  // Prefer check rollup when available; fall back to mergeStateStatus.
  if (hasFailedChecks) return "text-danger-soft";
  if (hasPendingChecks) return "text-warning";
  // GitHub marks UNSTABLE for non-passing states (including pending), so only treat it
  // as failing when rollup doesn't already say pending/failed.
  if (mergeStateStatus === "UNSTABLE") return "text-danger-soft";

  if (mergeStateStatus === "BLOCKED" || mergeStateStatus === "HAS_HOOKS") {
    return "text-warning";
  }

  return "text-muted";
}

/**
 * Get status icon based on PR state.
 * When refreshing with cached status, we show the cached status icon (not a spinner).
 */
function StatusIcon({ prLink }: { prLink: GitHubPRLinkWithStatus }) {
  // Only show spinner when loading without any cached status
  if (prLink.loading && !prLink.status) {
    return <Loader2 className="h-3 w-3 animate-spin" />;
  }
  if (prLink.error) {
    return <AlertCircle className="h-3 w-3" />;
  }
  if (!prLink.status) {
    return <GitPullRequest className="h-3 w-3" />;
  }

  const { state, mergeable, mergeStateStatus, isDraft, hasFailedChecks, hasPendingChecks } =
    prLink.status;

  if (state === "MERGED") {
    return <Check className="h-3 w-3" />;
  }
  if (state === "CLOSED") {
    return <X className="h-3 w-3" />;
  }

  if (isDraft || mergeStateStatus === "DRAFT") {
    return <GitPullRequest className="h-3 w-3" />;
  }

  if (prLink.status.mergeQueueEntry != null) {
    return <Rocket className="h-3 w-3" />;
  }

  if (mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY") {
    return <X className="h-3 w-3" />;
  }

  if (mergeStateStatus === "CLEAN") {
    return <Check className="h-3 w-3" />;
  }

  // Prefer check rollup when available; fall back to mergeStateStatus.
  if (hasFailedChecks) {
    return <X className="h-3 w-3" />;
  }
  if (hasPendingChecks || mergeStateStatus === "BLOCKED") {
    return <CircleDot className="h-3 w-3" />;
  }
  // GitHub marks UNSTABLE for non-passing states (including pending), so only treat it
  // as failing when rollup doesn't already say pending/failed.
  if (mergeStateStatus === "UNSTABLE") {
    return <X className="h-3 w-3" />;
  }

  return <GitPullRequest className="h-3 w-3" />;
}

/**
 * Format PR tooltip content
 */
export function getTooltipContent(prLink: GitHubPRLinkWithStatus): string {
  // When refreshing with cached status, don't show "Loading..." - show the cached status
  if (prLink.loading && !prLink.status) return "Loading PR status...";
  if (prLink.error) return `Error: ${prLink.error}`;
  if (!prLink.status) return `PR #${prLink.number}`;

  const {
    title,
    state,
    mergeable,
    mergeStateStatus,
    isDraft,
    mergeQueueEntry,
    hasFailedChecks,
    hasPendingChecks,
    headRefName,
    baseRefName,
  } = prLink.status;

  const lines = [title || `PR #${prLink.number}`];

  if (isDraft) {
    lines.push("Draft PR");
  } else if (mergeQueueEntry != null) {
    lines.push(
      mergeQueueEntry.position != null
        ? `In merge queue (position ${mergeQueueEntry.position + 1})`
        : "In merge queue"
    );
  } else if (state === "MERGED") {
    lines.push("Merged");
  } else if (state === "CLOSED") {
    lines.push("Closed");
  } else {
    if (mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY") {
      lines.push("Has merge conflicts");
    } else if (mergeStateStatus === "BEHIND") {
      lines.push("Behind base branch");
    } else if (mergeStateStatus === "CLEAN") {
      lines.push("Ready to merge");
    } else if (hasFailedChecks) {
      lines.push("Checks failing");
    } else if (hasPendingChecks) {
      lines.push("Checks pending");
    } else if (mergeStateStatus === "UNSTABLE") {
      // GitHub marks UNSTABLE for non-passing states (including pending), so only fall back here.
      lines.push("Checks failing");
    } else if (mergeStateStatus === "BLOCKED" || mergeStateStatus === "HAS_HOOKS") {
      lines.push("Merge blocked");
    } else {
      lines.push("Open");
    }
  }

  lines.push(`${headRefName} → ${baseRefName}`);

  return lines.join("\n");
}

function getReviewDecisionLabel(reviewDecision: string | null): string {
  if (!reviewDecision) {
    return "None";
  }
  if (reviewDecision === "APPROVED") {
    return "Approved";
  }
  if (reviewDecision === "REVIEW_REQUIRED") {
    return "Review required";
  }
  if (reviewDecision === "CHANGES_REQUESTED") {
    return "Changes requested";
  }
  return reviewDecision;
}

export function getReviewerCategoryLabel(
  category: WorkspacePullRequestFeed["reviewers"][number]["category"]
): string {
  if (category === "codex") return "Codex";
  if (category === "coderabbit") return "CodeRabbit";
  if (category === "greptile") return "Greptile";
  if (category === "human") return "Human";
  return "Unknown bot";
}

function getThreadLeadComment(thread: PullRequestReviewThread): PullRequestReviewComment | null {
  return (
    thread.comments.find((comment) => comment.body.trim().length > 0) ?? thread.comments[0] ?? null
  );
}

function getActionableThreads(feed: WorkspacePullRequestFeed): PullRequestReviewThread[] {
  return feed.threads.filter((thread) => !thread.isResolved && !thread.isOutdated);
}

export function buildRemediationStartMessage(feed: WorkspacePullRequestFeed): string {
  const actionableThreads = getActionableThreads(feed);
  const findings = actionableThreads
    .map((thread, index) => {
      const comment = getThreadLeadComment(thread);
      if (!comment) {
        return `${index + 1}. [Unknown reviewer] unresolved review thread ${thread.id}`;
      }
      const location =
        comment.path != null
          ? `${comment.path}${comment.line != null ? `:${comment.line}` : ""}`
          : "location unavailable";
      const reviewer = `${comment.author.login} (${getReviewerCategoryLabel(comment.author.category)})`;
      return `${index + 1}. [${reviewer}] ${location}\n${comment.body.trim()}`;
    })
    .join("\n\n");

  const reviewerSummary =
    feed.reviewers.length > 0
      ? feed.reviewers
          .map((reviewer) => `- ${reviewer.login} (${getReviewerCategoryLabel(reviewer.category)})`)
          .join("\n")
      : "- No reviewers detected";

  return [
    "Address pull request feedback in this forked workspace.",
    "",
    `PR: ${feed.pr?.url ?? "unknown"}`,
    `Review decision: ${getReviewDecisionLabel(feed.reviewDecision)}`,
    `Checks: pending=${feed.checksSummary.hasPendingChecks ? "yes" : "no"}, failed=${feed.checksSummary.hasFailedChecks ? "yes" : "no"}`,
    `Actionable unresolved threads: ${actionableThreads.length}`,
    "",
    "Reviewers:",
    reviewerSummary,
    "",
    "Actionable findings:",
    findings.length > 0 ? findings : "- No unresolved actionable findings were detected.",
    "",
    "Implement fixes for the findings, run relevant validation, commit, push, and re-check PR status.",
    "Preserve reviewer attribution in your responses and commit notes.",
  ].join("\n");
}

function FeedThreadDetails({ thread }: { thread: PullRequestReviewThread }) {
  const leadComment = getThreadLeadComment(thread);

  if (!leadComment) {
    return (
      <div className="text-muted text-xs" data-testid={`pr-thread-${thread.id}`}>
        Thread {thread.id}
      </div>
    );
  }

  const location =
    leadComment.path != null
      ? `${leadComment.path}${leadComment.line != null ? `:${leadComment.line}` : ""}`
      : "General";

  return (
    <div className="border-border-light bg-surface-secondary rounded border px-2 py-1.5 text-xs">
      <div className="text-muted mb-1 flex items-center justify-between gap-2">
        <span className="truncate">{location}</span>
        <span className="shrink-0">
          {leadComment.author.login} · {getReviewerCategoryLabel(leadComment.author.category)}
        </span>
      </div>
      <p className="text-content-primary line-clamp-3 whitespace-pre-wrap">
        {leadComment.body.trim()}
      </p>
    </div>
  );
}

export function PRLinkBadge({ prLink, feed, onPushToFix }: PRLinkBadgeProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPushingToFix, setIsPushingToFix] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const colorClass = getStatusColorClass(prLink);
  // Show pulse effect when refreshing with cached status (optimistic UI)
  const isRefreshing = prLink.loading && prLink.status != null;
  const actionableThreadCount = feed ? getActionableThreads(feed).length : 0;

  const handlePushToFix = async () => {
    if (!feed || !onPushToFix || isPushingToFix) {
      return;
    }

    setPushError(null);
    setIsPushingToFix(true);
    try {
      await onPushToFix(buildRemediationStartMessage(feed));
      setIsOpen(false);
    } catch (error) {
      setPushError(error instanceof Error ? error.message : "Failed to fork remediation workspace");
    } finally {
      setIsPushingToFix(false);
    }
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                "h-6 gap-1 px-2 text-xs font-medium",
                colorClass,
                isRefreshing && "animate-pulse"
              )}
            >
              <StatusIcon prLink={prLink} />
              <span>#{prLink.number}</span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent align="center" className="whitespace-pre-line">
          {getTooltipContent(prLink)}
        </TooltipContent>
      </Tooltip>

      <PopoverContent align="end" side="bottom" className="w-[460px] max-w-[90vw] p-0">
        <div className="border-border-light flex items-center justify-between border-b px-3 py-2">
          <div className="min-w-0">
            <p className="text-content-primary truncate text-xs font-semibold">
              {prLink.status?.title ?? `PR #${prLink.number}`}
            </p>
            <p className="text-muted text-xs">#{prLink.number}</p>
          </div>
          <a
            href={prLink.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted hover:text-content-primary inline-flex items-center gap-1 text-xs"
          >
            Open PR
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>

        {feed ? (
          <div className="space-y-3 px-3 py-2">
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <span className="text-muted">Review decision</span>
              <span className="text-content-primary">
                {getReviewDecisionLabel(feed.reviewDecision)}
              </span>
              <span className="text-muted">Checks</span>
              <span className="text-content-primary">
                pending {feed.checksSummary.hasPendingChecks ? "yes" : "no"}, failed{" "}
                {feed.checksSummary.hasFailedChecks ? "yes" : "no"}
              </span>
              <span className="text-muted">Reviewers</span>
              <span className="text-content-primary">{feed.reviewers.length}</span>
              <span className="text-muted">Unresolved threads</span>
              <span className="text-content-primary">{actionableThreadCount}</span>
            </div>

            <div className="space-y-1">
              <p className="text-muted text-[11px] uppercase">Reviewers</p>
              {feed.reviewers.length > 0 ? (
                <ul className="space-y-1">
                  {feed.reviewers.map((reviewer) => (
                    <li
                      key={`${reviewer.login}-${reviewer.category}`}
                      className="border-border-light bg-surface-secondary flex items-center justify-between rounded border px-2 py-1 text-xs"
                    >
                      <span className="text-content-primary">{reviewer.login}</span>
                      <span className="text-muted">
                        {getReviewerCategoryLabel(reviewer.category)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted text-xs">No reviewers detected yet.</p>
              )}
            </div>

            <div className="space-y-1">
              <p className="text-muted text-[11px] uppercase">Review threads</p>
              {feed.threads.length > 0 ? (
                <div className="max-h-52 space-y-1 overflow-y-auto pr-1">
                  {feed.threads.slice(0, 8).map((thread) => (
                    <FeedThreadDetails key={thread.id} thread={thread} />
                  ))}
                </div>
              ) : (
                <p className="text-muted text-xs">No review threads detected yet.</p>
              )}
            </div>

            {onPushToFix && (
              <div className="border-border-light flex items-center justify-between gap-2 border-t pt-2">
                <div className="text-muted text-xs">
                  Push unresolved findings to a remediation fork workspace.
                </div>
                <Button type="button" size="sm" onClick={handlePushToFix} disabled={isPushingToFix}>
                  {isPushingToFix ? "Forking…" : "Push to agent to fix"}
                </Button>
              </div>
            )}

            {pushError && <p className="text-danger-soft text-xs">{pushError}</p>}
          </div>
        ) : (
          <div className="text-muted px-3 py-3 text-xs">Loading pull request details…</div>
        )}
      </PopoverContent>
    </Popover>
  );
}
