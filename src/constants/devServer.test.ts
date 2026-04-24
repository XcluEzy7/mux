import { describe, expect, test } from "bun:test";

import { DEFAULT_DEV_UI_PORT, getDesktopDevServerOrigin } from "./devServer";

describe("getDesktopDevServerOrigin", () => {
  test("defaults to the local Vite port", () => {
    expect(getDesktopDevServerOrigin({} as NodeJS.ProcessEnv)).toBe(
      `http://127.0.0.1:${DEFAULT_DEV_UI_PORT}`
    );
  });

  test("prefers the explicit desktop override over the Vite port", () => {
    expect(
      getDesktopDevServerOrigin({
        MUX_DEVSERVER_HOST: "localhost",
        MUX_DEVSERVER_PORT: "4111",
        MUX_VITE_PORT: "4222",
      } as NodeJS.ProcessEnv)
    ).toBe("http://localhost:4111");
  });

  test("falls back to the Vite port when the desktop override is unset", () => {
    expect(
      getDesktopDevServerOrigin({
        MUX_VITE_PORT: "4222",
      } as NodeJS.ProcessEnv)
    ).toBe("http://127.0.0.1:4222");
  });

  test("treats empty env overrides as unset", () => {
    expect(
      getDesktopDevServerOrigin({
        MUX_DEVSERVER_HOST: "   ",
        MUX_DEVSERVER_PORT: "",
        MUX_VITE_PORT: "",
      } as NodeJS.ProcessEnv)
    ).toBe(`http://127.0.0.1:${DEFAULT_DEV_UI_PORT}`);
  });

  test("formats IPv6 hosts correctly", () => {
    expect(
      getDesktopDevServerOrigin({
        MUX_DEVSERVER_HOST: "::1",
      } as NodeJS.ProcessEnv)
    ).toBe(`http://[::1]:${DEFAULT_DEV_UI_PORT}`);
  });
});
