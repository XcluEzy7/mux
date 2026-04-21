import type {
  GitHubPRLink,
  GitHubPRStatus,
  MergeQueueEntry,
  PullRequestReviewComment,
  PullRequestReviewThread,
  PullRequestReviewerCategory,
  PullRequestReviewerIdentity,
} from "@/common/types/links";

const REVIEWER_CATEGORY_BY_BOT_LOGIN: Record<
  string,
  Exclude<PullRequestReviewerCategory, "human" | "unknown-bot">
> = {
  "openai-codex-reviewer[bot]": "codex",
  "codex[bot]": "codex",
  "coderabbitai[bot]": "coderabbit",
  coderabbitai: "coderabbit",
  "greptile[bot]": "greptile",
  "greptile-ai[bot]": "greptile",
  "greptile-apps[bot]": "greptile",
};

export const GH_PR_VIEW_JSON_FIELDS = [
  "number",
  "url",
  "state",
  "mergeable",
  "mergeStateStatus",
  "title",
  "isDraft",
  "headRefName",
  "baseRefName",
  "statusCheckRollup",
  "reviewDecision",
  "reviews",
].join(",");

export const MERGE_QUEUE_AND_THREADS_QUERY =
  "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){mergeQueueEntry{state position} reviewThreads(first:100){nodes{id isResolved isOutdated comments(first:100){nodes{id url body path line createdAt replyTo{id} author{login __typename}}}}}}}";

function getObjectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function getString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function getBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function getNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export function parseGitHubPRUrl(
  url: string
): { owner: string; repo: string; number: number } | null {
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!match) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2],
    number: Number.parseInt(match[3], 10),
  };
}

export function summarizeStatusCheckRollup(raw: unknown): {
  hasPendingChecks: boolean;
  hasFailedChecks: boolean;
} {
  if (!Array.isArray(raw)) {
    return { hasPendingChecks: false, hasFailedChecks: false };
  }

  let hasPendingChecks = false;
  let hasFailedChecks = false;

  for (const item of raw) {
    const record = getObjectRecord(item);
    if (!record) {
      continue;
    }

    const status = getString(record.status);
    const conclusion = getString(record.conclusion);

    if (status && status !== "COMPLETED") {
      hasPendingChecks = true;
    }

    if (!conclusion) {
      if (status !== "COMPLETED") {
        hasPendingChecks = true;
      }
      continue;
    }

    const normalized = conclusion.toUpperCase();
    if (
      normalized === "FAILURE" ||
      normalized === "CANCELLED" ||
      normalized === "TIMED_OUT" ||
      normalized === "ACTION_REQUIRED" ||
      normalized === "STARTUP_FAILURE"
    ) {
      hasFailedChecks = true;
    }
  }

  return { hasPendingChecks, hasFailedChecks };
}

export function parseMergeQueueEntry(raw: unknown): MergeQueueEntry | null {
  const record = getObjectRecord(raw);
  if (!record) {
    return null;
  }

  return {
    state: getString(record.state) ?? "QUEUED",
    position: getNonNegativeInteger(record.position),
  };
}

export function categorizeReviewer(login: string, isBot: boolean): PullRequestReviewerCategory {
  if (!isBot) {
    return "human";
  }

  const category = REVIEWER_CATEGORY_BY_BOT_LOGIN[login.toLowerCase()];
  if (category) {
    return category;
  }

  return "unknown-bot";
}

export function normalizeReviewerIdentity(rawAuthor: unknown): PullRequestReviewerIdentity | null {
  const author = getObjectRecord(rawAuthor);
  if (!author) {
    return null;
  }

  const login = getString(author.login);
  if (!login) {
    return null;
  }

  const knownCategory = REVIEWER_CATEGORY_BY_BOT_LOGIN[login.toLowerCase()];
  const typename = getString(author.__typename);
  const inferredBot = typename === "Bot" || /\[bot\]$/i.test(login);
  const explicitBot = getBoolean(author.is_bot) === true;
  const isBot = explicitBot || inferredBot || Boolean(knownCategory);

  return {
    login,
    isBot,
    category: knownCategory ?? categorizeReviewer(login, isBot),
  };
}

export function collectReviewers(
  reviewsRaw: unknown,
  threads: PullRequestReviewThread[]
): PullRequestReviewerIdentity[] {
  const byLogin = new Map<string, PullRequestReviewerIdentity>();

  if (Array.isArray(reviewsRaw)) {
    for (const reviewRaw of reviewsRaw) {
      const review = getObjectRecord(reviewRaw);
      if (!review) {
        continue;
      }
      const identity = normalizeReviewerIdentity(review.author);
      if (identity) {
        byLogin.set(identity.login.toLowerCase(), identity);
      }
    }
  }

  for (const thread of threads) {
    for (const comment of thread.comments) {
      byLogin.set(comment.author.login.toLowerCase(), comment.author);
    }
  }

  return Array.from(byLogin.values()).sort((a, b) => a.login.localeCompare(b.login));
}

function normalizeReviewComment(rawComment: unknown): PullRequestReviewComment | null {
  const comment = getObjectRecord(rawComment);
  if (!comment) {
    return null;
  }

  const id = getString(comment.id);
  const body = getString(comment.body);
  const author = normalizeReviewerIdentity(comment.author);
  if (!id || body == null || !author) {
    return null;
  }

  const replyTo = getObjectRecord(comment.replyTo);

  return {
    id,
    url: getString(comment.url),
    body,
    path: getString(comment.path),
    line: getNonNegativeInteger(comment.line),
    createdAt: getString(comment.createdAt),
    replyToId: replyTo ? getString(replyTo.id) : null,
    author,
  };
}

export function parseReviewThreadsFromGraphql(
  rawGraphqlResponse: unknown
): PullRequestReviewThread[] {
  const root = getObjectRecord(rawGraphqlResponse);
  const data = root ? getObjectRecord(root.data) : null;
  const repository = data ? getObjectRecord(data.repository) : null;
  const pullRequest = repository ? getObjectRecord(repository.pullRequest) : null;
  const reviewThreads = pullRequest ? getObjectRecord(pullRequest.reviewThreads) : null;
  const nodes = reviewThreads?.nodes;

  if (!Array.isArray(nodes)) {
    return [];
  }

  const result: PullRequestReviewThread[] = [];

  for (const nodeRaw of nodes) {
    const node = getObjectRecord(nodeRaw);
    if (!node) {
      continue;
    }

    const id = getString(node.id);
    if (!id) {
      continue;
    }

    const commentsConnection = getObjectRecord(node.comments);
    const commentNodes = commentsConnection?.nodes;
    const comments: PullRequestReviewComment[] = [];

    if (Array.isArray(commentNodes)) {
      for (const commentRaw of commentNodes) {
        const comment = normalizeReviewComment(commentRaw);
        if (comment) {
          comments.push(comment);
        }
      }
    }

    if (comments.length === 0) {
      continue;
    }

    result.push({
      id,
      isResolved: getBoolean(node.isResolved) ?? false,
      isOutdated: getBoolean(node.isOutdated) ?? false,
      comments,
    });
  }

  return result;
}

export function parseMergeQueueEntryFromGraphql(
  rawGraphqlResponse: unknown
): MergeQueueEntry | null {
  const root = getObjectRecord(rawGraphqlResponse);
  const data = root ? getObjectRecord(root.data) : null;
  const repository = data ? getObjectRecord(data.repository) : null;
  const pullRequest = repository ? getObjectRecord(repository.pullRequest) : null;

  return parseMergeQueueEntry(pullRequest?.mergeQueueEntry);
}

export function buildGitHubPRLink(url: string, fetchedAt: number): GitHubPRLink | null {
  const base = parseGitHubPRUrl(url);
  if (!base) {
    return null;
  }

  return {
    type: "github-pr",
    url,
    owner: base.owner,
    repo: base.repo,
    number: base.number,
    detectedAt: fetchedAt,
    occurrenceCount: 1,
  };
}

export function buildGitHubPRStatus(rawViewResponse: unknown, fetchedAt: number): GitHubPRStatus {
  const response = getObjectRecord(rawViewResponse) ?? {};
  const checksSummary = summarizeStatusCheckRollup(response.statusCheckRollup);

  return {
    state: (getString(response.state) as GitHubPRStatus["state"]) ?? "OPEN",
    mergeable: (getString(response.mergeable) as GitHubPRStatus["mergeable"]) ?? "UNKNOWN",
    mergeStateStatus:
      (getString(response.mergeStateStatus) as GitHubPRStatus["mergeStateStatus"]) ?? "UNKNOWN",
    title: getString(response.title) ?? "",
    isDraft: getBoolean(response.isDraft) ?? false,
    headRefName: getString(response.headRefName) ?? "",
    baseRefName: getString(response.baseRefName) ?? "",
    hasPendingChecks: checksSummary.hasPendingChecks,
    hasFailedChecks: checksSummary.hasFailedChecks,
    fetchedAt,
  };
}
