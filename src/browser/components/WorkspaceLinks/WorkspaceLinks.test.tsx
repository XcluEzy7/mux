import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import * as APIModule from "@/browser/contexts/API";
import * as PRStatusStoreModule from "@/browser/stores/PRStatusStore";
import * as ChatCommandsModule from "@/browser/utils/chatCommands";
import * as SendOptionsModule from "@/browser/utils/messages/sendOptions";
import * as PRLinkBadgeModule from "../PRLinkBadge/PRLinkBadge";
import { WorkspaceLinks } from "./WorkspaceLinks";

let cleanupDom: (() => void) | null = null;

const mockAPI = {} as ReturnType<typeof APIModule.useAPI>["api"];

describe("WorkspaceLinks", () => {
  beforeEach(() => {
    cleanupDom = installDom();

    spyOn(APIModule, "useAPI").mockImplementation(
      () => ({ api: mockAPI }) as unknown as ReturnType<typeof APIModule.useAPI>
    );
    spyOn(PRStatusStoreModule, "useWorkspacePR").mockImplementation(
      () =>
        ({
          type: "github-pr",
          owner: "coder",
          repo: "mux",
          number: 77,
          url: "https://github.com/coder/mux/pull/77",
          detectedAt: 0,
          occurrenceCount: 1,
          loading: false,
        }) as ReturnType<typeof PRStatusStoreModule.useWorkspacePR>
    );
    spyOn(PRStatusStoreModule, "useWorkspacePullRequestFeed").mockImplementation(
      () =>
        ({
          workspaceId: "ws-1",
          pr: {
            type: "github-pr",
            owner: "coder",
            repo: "mux",
            number: 77,
            url: "https://github.com/coder/mux/pull/77",
            detectedAt: 0,
            occurrenceCount: 1,
          },
          reviewDecision: null,
          checksSummary: { hasPendingChecks: false, hasFailedChecks: false },
          reviewers: [],
          threads: [],
          fetchedAt: Date.now(),
        }) as ReturnType<typeof PRStatusStoreModule.useWorkspacePullRequestFeed>
    );
    spyOn(ChatCommandsModule, "forkWorkspace").mockImplementation(() =>
      Promise.resolve({ success: true as const })
    );
    spyOn(SendOptionsModule, "getSendOptionsFromStorage").mockImplementation(
      () =>
        ({ model: "openai:gpt-5" }) as ReturnType<
          typeof SendOptionsModule.getSendOptionsFromStorage
        >
    );
    spyOn(PRLinkBadgeModule, "PRLinkBadge").mockImplementation(((
      props: ComponentProps<typeof PRLinkBadgeModule.PRLinkBadge>
    ) => (
      <button
        type="button"
        data-testid="mock-pr-badge"
        onClick={async () => {
          if (props.onPushToFix) {
            await props.onPushToFix("Fix this pull request");
          }
        }}
      >
        PR #{props.prLink.number}
      </button>
    )) as unknown as typeof PRLinkBadgeModule.PRLinkBadge);
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    mock.restore();
  });

  test("passes remediation action that forks with seeded start message", async () => {
    const view = render(<WorkspaceLinks workspaceId="ws-1" />);

    fireEvent.click(view.getByTestId("mock-pr-badge"));

    await Promise.resolve();

    expect(ChatCommandsModule.forkWorkspace).toHaveBeenCalledWith({
      client: mockAPI,
      sourceWorkspaceId: "ws-1",
      startMessage: "Fix this pull request",
      sendMessageOptions: { model: "openai:gpt-5" },
    });
  });

  test("renders nothing when no linked PR exists", () => {
    spyOn(PRStatusStoreModule, "useWorkspacePR").mockImplementation(() => null);

    const view = render(<WorkspaceLinks workspaceId="ws-1" />);

    expect(view.queryByTestId("mock-pr-badge")).toBeNull();
  });
});
