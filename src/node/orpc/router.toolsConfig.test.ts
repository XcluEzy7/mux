import { describe, expect, it } from "bun:test";

import type { ToolsConfig } from "@/common/config/schemas";
import { normalizeToolsConfigForSave } from "./router";

describe("normalizeToolsConfigForSave", () => {
  it("preserves intentional empty custom tool args", () => {
    const tools: ToolsConfig = {
      defaults: { mode: "allow_all_except", toolNames: [] },
      custom: [
        {
          id: " tool-1 ",
          label: " Tool 1 ",
          command: " npx ",
          args: ["--flag", "", "tail"],
          enabled: true,
        },
      ],
    };

    expect(normalizeToolsConfigForSave(tools)).toEqual({
      defaults: { mode: "allow_all_except", toolNames: [] },
      custom: [
        {
          id: "tool-1",
          label: "Tool 1",
          command: "npx",
          args: ["--flag", "", "tail"],
          enabled: true,
        },
      ],
    });
  });

  it("keeps normalization safeguards for invalid tools", () => {
    const tools: ToolsConfig = {
      defaults: { mode: "allow_all_except", toolNames: ["", "bash"] },
      custom: [
        {
          id: "",
          label: "Missing ID",
          command: "npx",
          args: [],
          enabled: true,
        },
      ],
    };

    expect(normalizeToolsConfigForSave(tools)).toEqual({
      defaults: { mode: "allow_all_except", toolNames: ["bash"] },
      custom: [],
    });
  });
});
