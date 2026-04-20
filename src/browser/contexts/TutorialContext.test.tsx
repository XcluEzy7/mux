import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import {
  DEFAULT_TUTORIAL_STATE,
  TUTORIAL_STATE_KEY,
  type TutorialState,
} from "@/common/constants/storage";

void mock.module("@/browser/components/TutorialTooltip/TutorialTooltip", () => ({
  TutorialTooltip: (props: { step: { title: string } }) => (
    <div data-testid="tutorial-tooltip">{props.step.title}</div>
  ),
}));

void mock.module("@/browser/features/SplashScreens/SplashScreenProvider", () => ({
  useIsSplashScreenActive: () => false,
}));

import {
  TutorialProvider,
  resolveTutorialSandboxOptIn,
  useOptionalTutorial,
  useTutorial,
} from "./TutorialContext";

function TutorialHarness() {
  const tutorial = useTutorial();

  return (
    <div>
      <button data-testid="start-creation" onClick={() => tutorial.startSequence("creation")}>
        Start creation
      </button>
      <span data-testid="tutorial-disabled">{String(tutorial.isTutorialDisabled())}</span>
    </div>
  );
}

function OptionalTutorialHarness() {
  const tutorial = useOptionalTutorial();

  return <span data-testid="optional-tutorial-present">{String(tutorial !== null)}</span>;
}

function StrictTutorialOutsideProviderHarness() {
  useTutorial();
  return <div>unreachable</div>;
}

function readStoredTutorialState(): TutorialState | null {
  const raw = window.localStorage.getItem(TUTORIAL_STATE_KEY);
  if (!raw) {
    return null;
  }

  return JSON.parse(raw) as TutorialState;
}

describe("TutorialContext", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalNavigator: typeof globalThis.navigator;
  let originalLocalStorage: typeof globalThis.localStorage;
  let originalGetComputedStyle: typeof globalThis.getComputedStyle;
  let originalStorageEvent: unknown;
  let originalCustomEvent: unknown;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalNavigator = globalThis.navigator;
    originalLocalStorage = globalThis.localStorage;
    originalGetComputedStyle = globalThis.getComputedStyle;
    originalStorageEvent = (globalThis as Record<string, unknown>).StorageEvent;
    originalCustomEvent = (globalThis as Record<string, unknown>).CustomEvent;

    const dom = new GlobalWindow();
    globalThis.window = dom as unknown as Window & typeof globalThis;
    globalThis.document = dom.document as unknown as Document;
    globalThis.navigator = dom.navigator as unknown as Navigator;
    globalThis.localStorage = dom.localStorage;
    globalThis.getComputedStyle = dom.getComputedStyle.bind(
      dom
    ) as unknown as typeof getComputedStyle;

    const domGlobals = globalThis as Record<string, unknown>;
    domGlobals.StorageEvent = dom.StorageEvent;
    domGlobals.CustomEvent = dom.CustomEvent;

    window.localStorage.clear();
    delete window.api;
    globalThis.__MUX_ENABLE_TUTORIALS_IN_SANDBOX__ = undefined;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.__MUX_ENABLE_TUTORIALS_IN_SANDBOX__ = undefined;
    globalThis.getComputedStyle = originalGetComputedStyle;
    globalThis.localStorage = originalLocalStorage;
    globalThis.navigator = originalNavigator;
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;

    const domGlobals = globalThis as Record<string, unknown>;
    domGlobals.StorageEvent = originalStorageEvent;
    domGlobals.CustomEvent = originalCustomEvent;
  });

  test("resolveTutorialSandboxOptIn returns undefined when neither transport provides an override", () => {
    expect(
      resolveTutorialSandboxOptIn({
        preloadEnableTutorialsInSandbox: undefined,
        browserEnableTutorialsInSandbox: undefined,
      })
    ).toBeUndefined();
  });

  test("resolveTutorialSandboxOptIn prefers preload over the browser fallback", () => {
    expect(
      resolveTutorialSandboxOptIn({
        preloadEnableTutorialsInSandbox: false,
        browserEnableTutorialsInSandbox: true,
      })
    ).toBe(false);
    expect(
      resolveTutorialSandboxOptIn({
        preloadEnableTutorialsInSandbox: undefined,
        browserEnableTutorialsInSandbox: true,
      })
    ).toBe(true);
  });

  test("useTutorial stays strict outside TutorialProvider", () => {
    expect(() => render(<StrictTutorialOutsideProviderHarness />)).toThrow(
      "useTutorial must be used within a TutorialProvider"
    );
  });

  test("useOptionalTutorial returns null outside TutorialProvider", () => {
    const view = render(<OptionalTutorialHarness />);
    expect(view.getByTestId("optional-tutorial-present").textContent).toBe("false");
  });

  test("useOptionalTutorial returns context value inside TutorialProvider", () => {
    const view = render(
      <TutorialProvider>
        <OptionalTutorialHarness />
      </TutorialProvider>
    );

    expect(view.getByTestId("optional-tutorial-present").textContent).toBe("true");
  });

  test("keeps normal tutorial behavior when no sandbox override is present", async () => {
    const view = render(
      <TutorialProvider>
        <TutorialHarness />
      </TutorialProvider>
    );

    expect(view.getByTestId("tutorial-disabled").textContent).toBe("false");

    fireEvent.click(view.getByTestId("start-creation"));

    await waitFor(() => {
      expect(view.getByTestId("tutorial-tooltip")).toBeTruthy();
    });
  });

  test("browser sandbox default blocks tutorials without persisting a forced disable", async () => {
    globalThis.__MUX_ENABLE_TUTORIALS_IN_SANDBOX__ = false;

    const view = render(
      <TutorialProvider>
        <TutorialHarness />
      </TutorialProvider>
    );

    expect(view.getByTestId("tutorial-disabled").textContent).toBe("true");
    fireEvent.click(view.getByTestId("start-creation"));

    await waitFor(() => {
      expect(readStoredTutorialState()).toEqual(DEFAULT_TUTORIAL_STATE);
    });
    expect(view.queryByTestId("tutorial-tooltip")).toBeNull();
  });

  test("browser sandbox opt-in restores the tutorial flow", async () => {
    globalThis.__MUX_ENABLE_TUTORIALS_IN_SANDBOX__ = true;

    const view = render(
      <TutorialProvider>
        <TutorialHarness />
      </TutorialProvider>
    );

    expect(view.getByTestId("tutorial-disabled").textContent).toBe("false");
    fireEvent.click(view.getByTestId("start-creation"));

    await waitFor(() => {
      expect(view.getByTestId("tutorial-tooltip")).toBeTruthy();
    });
  });

  test("preload override takes precedence over the browser fallback", () => {
    globalThis.__MUX_ENABLE_TUTORIALS_IN_SANDBOX__ = true;
    window.api = {
      platform: "linux",
      versions: {},
      enableTutorialsInSandbox: false,
    };

    const view = render(
      <TutorialProvider>
        <TutorialHarness />
      </TutorialProvider>
    );

    expect(view.getByTestId("tutorial-disabled").textContent).toBe("true");
    fireEvent.click(view.getByTestId("start-creation"));
    expect(view.queryByTestId("tutorial-tooltip")).toBeNull();
  });

  test("persisted tutorial disables still win over sandbox opt-in", () => {
    globalThis.__MUX_ENABLE_TUTORIALS_IN_SANDBOX__ = true;
    window.localStorage.setItem(
      TUTORIAL_STATE_KEY,
      JSON.stringify({
        disabled: true,
        completed: {},
      } satisfies TutorialState)
    );

    const view = render(
      <TutorialProvider>
        <TutorialHarness />
      </TutorialProvider>
    );

    expect(view.getByTestId("tutorial-disabled").textContent).toBe("true");
    fireEvent.click(view.getByTestId("start-creation"));
    expect(view.queryByTestId("tutorial-tooltip")).toBeNull();
  });
});
