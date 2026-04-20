import { describe, expect, it } from "bun:test";
import {
  categorizeReviewer,
  collectReviewers,
  parseMergeQueueEntry,
  parseMergeQueueEntryFromGraphql,
  parseReviewThreadsFromGraphql,
  summarizeStatusCheckRollup,
} from "./pullRequestFeed";

describe("pullRequestFeed helpers", () => {
  it("summarizes pending and failed checks from rollup entries", () => {
    expect(
      summarizeStatusCheckRollup([
        { status: "IN_PROGRESS", conclusion: null },
        { status: "COMPLETED", conclusion: "FAILURE" },
      ])
    ).toEqual({
      hasPendingChecks: true,
      hasFailedChecks: true,
    });
  });

  it("normalizes merge queue entries", () => {
    expect(parseMergeQueueEntry({ state: "QUEUED", position: 0 })).toEqual({
      state: "QUEUED",
      position: 0,
    });
    expect(parseMergeQueueEntry({ position: -1 })).toEqual({ state: "QUEUED", position: null });
    expect(parseMergeQueueEntry(null)).toBeNull();
  });

  it("parses merge queue entry from graphql payload", () => {
    expect(
      parseMergeQueueEntryFromGraphql({
        data: {
          repository: {
            pullRequest: {
              mergeQueueEntry: {
                state: "AWAITING_CHECKS",
                position: 4,
              },
            },
          },
        },
      })
    ).toEqual({ state: "AWAITING_CHECKS", position: 4 });
  });

  it("parses review threads and comment metadata", () => {
    const threads = parseReviewThreadsFromGraphql({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "thread-1",
                  isResolved: false,
                  isOutdated: false,
                  comments: {
                    nodes: [
                      {
                        id: "comment-1",
                        url: "https://github.com/example/repo/pull/1#discussion_r1",
                        body: "please fix",
                        path: "src/main.ts",
                        line: 10,
                        createdAt: "2026-04-20T00:00:00Z",
                        replyTo: null,
                        author: { login: "coderabbitai", __typename: "Bot" },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    });

    expect(threads).toEqual([
      {
        id: "thread-1",
        isResolved: false,
        isOutdated: false,
        comments: [
          {
            id: "comment-1",
            url: "https://github.com/example/repo/pull/1#discussion_r1",
            body: "please fix",
            path: "src/main.ts",
            line: 10,
            createdAt: "2026-04-20T00:00:00Z",
            replyToId: null,
            author: {
              login: "coderabbitai",
              isBot: true,
              category: "coderabbit",
            },
          },
        ],
      },
    ]);
  });

  it("collects unique reviewers from reviews and thread comments", () => {
    const reviewers = collectReviewers(
      [
        { author: { login: "alice", is_bot: false } },
        { author: { login: "OpenAI-Codex-Reviewer[bot]", is_bot: true } },
      ],
      [
        {
          id: "thread-1",
          isResolved: false,
          isOutdated: false,
          comments: [
            {
              id: "comment-1",
              url: null,
              body: "nit",
              path: null,
              line: null,
              createdAt: null,
              replyToId: null,
              author: {
                login: "greptilebot",
                isBot: true,
                category: "greptile",
              },
            },
          ],
        },
      ]
    );

    expect(reviewers).toEqual([
      { login: "alice", isBot: false, category: "human" },
      { login: "greptilebot", isBot: true, category: "greptile" },
      {
        login: "OpenAI-Codex-Reviewer[bot]",
        isBot: true,
        category: "codex",
      },
    ]);
  });

  it("categorizes unknown bots separately", () => {
    expect(categorizeReviewer("ci-helper[bot]", true)).toBe("unknown-bot");
  });
});
