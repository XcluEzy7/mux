import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

let currentWorkspaceState: {
  autoRetryStatus: { type: "auto-retry-scheduled" | "auto-retry-starting" } | null;
  isStreamStarting: boolean;
  canInterrupt: boolean;
  messages: Array<{ type: string; compactionRequest?: { parsed: unknown } }>;
} = {
  autoRetryStatus: null,
  isStreamStarting: false,
  canInterrupt: false,
  messages: [],
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

interface AnswerAskUserQuestionResult {
  success: true;
  data: { handoffAgentId: "exec" | "orchestrator" | null };
}

const answerAskUserQuestion = mock(
  (_input: unknown): Promise<AnswerAskUserQuestionResult> =>
    Promise.resolve({ success: true, data: { handoffAgentId: null } })
);

const resumeStream = mock((_input: unknown) =>
  Promise.resolve({ success: true as const, data: { started: true } })
);

const setAutoRetryEnabled = mock((input: unknown) => {
  const enabled =
    typeof input === "object" && input !== null && "enabled" in input
      ? (input as { enabled?: boolean }).enabled === true
      : false;

  return Promise.resolve({
    success: true as const,
    data: {
      // First call (enable=true) should look like user had retry disabled.
      previousEnabled: enabled ? false : true,
      enabled,
    },
  });
});

const getSendOptionsFromStorage = mock(() => ({
  model: "openai:gpt-4o-mini",
  agentId: "plan",
  thinkingLevel: "off",
}));

void mock.module("@/browser/utils/messages/sendOptions", () => ({
  getSendOptionsFromStorage,
}));

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: {
      workspace: {
        answerAskUserQuestion,
        resumeStream,
        setAutoRetryEnabled,
      },
    },
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

void mock.module("@/browser/stores/WorkspaceStore", () => ({
  useWorkspaceStoreRaw: () => ({
    subscribeKey: (_workspaceId: string, _listener: () => void) => () => undefined,
    getWorkspaceState: (_workspaceId: string) => currentWorkspaceState,
  }),
}));

import { AskUserQuestionToolCall } from "./AskUserQuestionToolCall";

describe("AskUserQuestionToolCall", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    currentWorkspaceState = {
      autoRetryStatus: null,
      isStreamStarting: false,
      canInterrupt: false,
      messages: [],
    };

    answerAskUserQuestion.mockClear();
    resumeStream.mockClear();
    setAutoRetryEnabled.mockClear();
    getSendOptionsFromStorage.mockClear();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("rolls back temporary auto-retry enablement when component unmounts", async () => {
    const view = render(
      <AskUserQuestionToolCall
        args={{ questions: [], answers: {} }}
        result={null}
        status="executing"
        toolCallId="ask-1"
        workspaceId="ws-ask"
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Submit answers" }));

    await waitFor(() => {
      expect(answerAskUserQuestion).toHaveBeenCalledTimes(1);
      expect(resumeStream).toHaveBeenCalledTimes(1);
      expect(setAutoRetryEnabled.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    view.unmount();

    await waitFor(() => {
      expect(setAutoRetryEnabled).toHaveBeenCalledTimes(2);
    });

    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-ask",
      enabled: true,
      persist: false,
    });
    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-ask",
      enabled: false,
      persist: false,
    });
  });

  test("restores preference when terminal update arrives without in-flight snapshots", async () => {
    const view = render(
      <AskUserQuestionToolCall
        args={{ questions: [], answers: {} }}
        result={null}
        status="executing"
        toolCallId="ask-3"
        workspaceId="ws-ask"
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Submit answers" }));

    await waitFor(() => {
      expect(answerAskUserQuestion).toHaveBeenCalledTimes(1);
      expect(resumeStream).toHaveBeenCalledTimes(1);
      expect(setAutoRetryEnabled.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    currentWorkspaceState = {
      ...currentWorkspaceState,
      autoRetryStatus: null,
      isStreamStarting: false,
      canInterrupt: false,
      messages: [{ type: "assistant" }],
    };
    view.rerender(
      <AskUserQuestionToolCall
        args={{ questions: [], answers: {} }}
        result={null}
        status="executing"
        toolCallId="ask-3"
        workspaceId="ws-ask"
      />
    );

    await waitFor(() => {
      expect(setAutoRetryEnabled).toHaveBeenCalledTimes(2);
    });

    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-ask",
      enabled: true,
      persist: false,
    });
    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-ask",
      enabled: false,
      persist: false,
    });
  });

  test("routes resume to exec when answer response returns exec handoff", async () => {
    answerAskUserQuestion.mockImplementationOnce((_input: unknown) =>
      Promise.resolve({ success: true as const, data: { handoffAgentId: "exec" as const } })
    );

    const view = render(
      <AskUserQuestionToolCall
        args={{ questions: [], answers: {} }}
        result={null}
        status="executing"
        toolCallId="ask-exec"
        workspaceId="ws-ask"
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Submit answers" }));

    await waitFor(() => {
      expect(resumeStream).toHaveBeenCalledTimes(1);
    });

    expect(resumeStream.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "ws-ask",
      options: { agentId: "exec" },
    });
  });

  test("routes resume to orchestrator when answer response returns orchestrator handoff", async () => {
    answerAskUserQuestion.mockImplementationOnce((_input: unknown) =>
      Promise.resolve({ success: true as const, data: { handoffAgentId: "orchestrator" as const } })
    );

    const view = render(
      <AskUserQuestionToolCall
        args={{ questions: [], answers: {} }}
        result={null}
        status="executing"
        toolCallId="ask-orchestrator"
        workspaceId="ws-ask"
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Submit answers" }));

    await waitFor(() => {
      expect(resumeStream).toHaveBeenCalledTimes(1);
    });

    expect(resumeStream.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "ws-ask",
      options: { agentId: "orchestrator" },
    });
  });

  test("keeps current send options when answer response has no handoff target", async () => {
    const view = render(
      <AskUserQuestionToolCall
        args={{ questions: [], answers: {} }}
        result={null}
        status="executing"
        toolCallId="ask-no-handoff"
        workspaceId="ws-ask"
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Submit answers" }));

    await waitFor(() => {
      expect(resumeStream).toHaveBeenCalledTimes(1);
    });

    expect(resumeStream.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "ws-ask",
      options: { agentId: "plan" },
    });
  });

  test("rolls back temporary retry enable when resume reports not started", async () => {
    resumeStream.mockImplementationOnce((_input: unknown) =>
      Promise.resolve({ success: true as const, data: { started: false } })
    );

    const view = render(
      <AskUserQuestionToolCall
        args={{ questions: [], answers: {} }}
        result={null}
        status="executing"
        toolCallId="ask-busy"
        workspaceId="ws-ask"
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Submit answers" }));

    await waitFor(() => {
      expect(setAutoRetryEnabled).toHaveBeenCalledTimes(2);
    });

    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-ask",
      enabled: true,
      persist: false,
    });
    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-ask",
      enabled: false,
      persist: false,
    });
  });

  test("restores auto-retry even when unmounted before async resume setup finishes", async () => {
    const answerDeferred = createDeferred<AnswerAskUserQuestionResult>();
    const resumeDeferred = createDeferred<{ success: true; data: { started: boolean } }>();

    answerAskUserQuestion.mockImplementationOnce((_input: unknown) => answerDeferred.promise);
    resumeStream.mockImplementationOnce((_input: unknown) => resumeDeferred.promise);

    const view = render(
      <AskUserQuestionToolCall
        args={{ questions: [], answers: {} }}
        result={null}
        status="executing"
        toolCallId="ask-2"
        workspaceId="ws-ask"
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Submit answers" }));

    // Simulate workspace switch/removal before async setup finishes.
    view.unmount();

    answerDeferred.resolve({ success: true, data: { handoffAgentId: null } });
    await waitFor(() => {
      expect(setAutoRetryEnabled).toHaveBeenCalledTimes(2);
    });

    resumeDeferred.resolve({ success: true, data: { started: true } });
    await waitFor(() => {
      expect(setAutoRetryEnabled).toHaveBeenCalledTimes(2);
    });

    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(1, {
      workspaceId: "ws-ask",
      enabled: true,
      persist: false,
    });
    expect(setAutoRetryEnabled).toHaveBeenNthCalledWith(2, {
      workspaceId: "ws-ask",
      enabled: false,
      persist: false,
    });
  });
});
