import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { ReactNode } from "react";
import type { ReviewFilters, ReviewStats } from "@/common/types/review";

let tutorialContext: {
  startSequence: (sequence: "creation" | "workspace" | "review") => void;
  isSequenceCompleted: (_sequence: "creation" | "workspace" | "review") => boolean;
  isTutorialDisabled: () => boolean;
} | null = null;

void mock.module("@/browser/hooks/usePersistedState", () => ({
  usePersistedState: (_key: string, defaultValue: string) => [
    defaultValue,
    (_value: string) => undefined,
  ],
}));

void mock.module("@/browser/contexts/TutorialContext", () => ({
  useOptionalTutorial: () => tutorialContext,
}));

void mock.module("./RefreshButton", () => ({
  RefreshButton: () => null,
}));

void mock.module("./BaseSelectorPopover", () => ({
  BaseSelectorPopover: (props: { value: string }) => (
    <button type="button" data-testid="review-base-value">
      {props.value}
    </button>
  ),
}));

void mock.module("@/browser/components/Tooltip/Tooltip", () => ({
  Tooltip: (props: { children: ReactNode }) => <>{props.children}</>,
  TooltipTrigger: (props: { children: ReactNode }) => <>{props.children}</>,
  TooltipContent: () => null,
  TooltipIfPresent: (props: { children: ReactNode }) => <>{props.children}</>,
}));

import { ReviewControls } from "./ReviewControls";

const DEFAULT_FILTERS: ReviewFilters = {
  showReadHunks: false,
  diffBase: "origin/main",
  includeUncommitted: true,
  sortOrder: "file-order",
};

const DEFAULT_STATS: ReviewStats = {
  total: 4,
  read: 1,
  unread: 3,
};

describe("ReviewControls tutorial integration", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalNavigator: typeof globalThis.navigator;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalNavigator = globalThis.navigator;

    const dom = new GlobalWindow({ url: "http://localhost" });
    globalThis.window = dom as unknown as Window & typeof globalThis;
    globalThis.document = dom.document as unknown as Document;
    globalThis.navigator = dom.navigator as unknown as Navigator;

    tutorialContext = null;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    tutorialContext = null;
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.navigator = originalNavigator;
  });

  test("renders without crashing when tutorial context is missing", () => {
    const view = render(
      <ReviewControls
        filters={DEFAULT_FILTERS}
        stats={DEFAULT_STATS}
        onFiltersChange={() => undefined}
        projectPath="/tmp/project"
      />
    );

    expect(view.getByText("Base:")).toBeTruthy();
    expect(view.getByTestId("review-base-value").textContent).toBe("origin/main");
  });

  test("starts review tutorial when tutorial context is available", async () => {
    const startSequence = mock((_sequence: "creation" | "workspace" | "review") => undefined);
    tutorialContext = {
      startSequence,
      isSequenceCompleted: () => false,
      isTutorialDisabled: () => false,
    };

    render(
      <ReviewControls
        filters={DEFAULT_FILTERS}
        stats={DEFAULT_STATS}
        onFiltersChange={() => undefined}
        projectPath="/tmp/project"
      />
    );

    await waitFor(
      () => {
        expect(startSequence).toHaveBeenCalledWith("review");
      },
      { timeout: 1_500 }
    );
  });
});
