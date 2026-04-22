import { describe, expect, it } from "bun:test";

import { AppConfigOnDiskSchema } from "./appConfigOnDisk";

describe("AppConfigOnDiskSchema", () => {
  it("validates default model setting", () => {
    const valid = { defaultModel: "anthropic:claude-sonnet-4-20250514" };

    expect(AppConfigOnDiskSchema.safeParse(valid).success).toBe(true);
  });

  it("validates hiddenModels array", () => {
    const valid = { hiddenModels: ["openai:gpt-4o", "google:gemini-pro"] };

    expect(AppConfigOnDiskSchema.safeParse(valid).success).toBe(true);
  });

  it("validates taskSettings with limits", () => {
    const valid = {
      taskSettings: {
        maxParallelAgentTasks: 5,
        maxTaskNestingDepth: 3,
      },
    };

    expect(AppConfigOnDiskSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects taskSettings outside limits", () => {
    const invalid = {
      taskSettings: {
        maxParallelAgentTasks: 999,
      },
    };

    expect(AppConfigOnDiskSchema.safeParse(invalid).success).toBe(false);
  });

  it("validates projects as tuple array", () => {
    const valid = { projects: [["/home/user/project", { workspaces: [] }]] };

    expect(AppConfigOnDiskSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts sparse runtimeEnablement overrides", () => {
    expect(AppConfigOnDiskSchema.safeParse({ runtimeEnablement: { ssh: false } }).success).toBe(
      true
    );
  });

  it("rejects runtimeEnablement values other than false", () => {
    expect(AppConfigOnDiskSchema.safeParse({ runtimeEnablement: { ssh: true } }).success).toBe(
      false
    );
  });

  it("preserves unknown future runtimeEnablement keys for forward-compatibility", () => {
    expect(
      AppConfigOnDiskSchema.safeParse({
        runtimeEnablement: { ssh: false, future_runtime: false },
      }).success
    ).toBe(true);
  });

  it("defaults missing custom tool args to an empty array", () => {
    const result = AppConfigOnDiskSchema.safeParse({
      tools: {
        defaults: { mode: "allow_all_except", toolNames: [] },
        custom: [
          {
            id: "weather_lookup",
            label: "Weather Lookup",
            command: "python",
            enabled: true,
          },
        ],
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.tools?.custom[0]?.args).toEqual([]);
  });

  it("defaults missing custom tool enabled state to true", () => {
    const result = AppConfigOnDiskSchema.safeParse({
      tools: {
        defaults: { mode: "allow_all_except", toolNames: [] },
        custom: [
          {
            id: "weather_lookup",
            label: "Weather Lookup",
            command: "python",
          },
        ],
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.tools?.custom[0]?.enabled).toBe(true);
  });

  it("preserves unknown fields via passthrough", () => {
    const valid = { futureField: "something" };

    const result = AppConfigOnDiskSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ futureField: "something" });
    }
  });
});
