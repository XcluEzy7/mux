import { describe, expect, it } from "bun:test";

import type { CustomTool } from "@/common/config/schemas";
import type { MCPServerInfo } from "@/common/types/mcp";
import { CUSTOM_TOOL_MCP_SERVER_PREFIX } from "@/common/constants/mcp";
import {
  buildSyntheticCustomToolServerCommandMap,
  shouldHideSyntheticCustomToolServer,
} from "./MCPSettingsSection";

function createCustomTool(overrides: Partial<CustomTool>): CustomTool {
  return {
    id: "weather",
    label: "Weather",
    command: "python",
    args: ["script.py"],
    enabled: true,
    ...overrides,
  };
}

describe("custom tool MCP server filtering", () => {
  it("builds command map from enabled custom tools", () => {
    const commandMap = buildSyntheticCustomToolServerCommandMap([
      createCustomTool({ id: "weather" }),
      createCustomTool({ id: "", command: "ignored" }),
      createCustomTool({ id: "disabled", enabled: false }),
    ]);

    expect(commandMap).toEqual({
      [`${CUSTOM_TOOL_MCP_SERVER_PREFIX}weather`]: "'python' 'script.py'",
    });
  });

  it("hides synthetic custom-tool-backed entries", () => {
    const commandMap = {
      [`${CUSTOM_TOOL_MCP_SERVER_PREFIX}weather`]: "'python' 'script.py'",
    };

    const syntheticServer: MCPServerInfo = {
      transport: "stdio",
      command: "'python' 'script.py'",
      disabled: false,
    };

    expect(
      shouldHideSyntheticCustomToolServer(
        `${CUSTOM_TOOL_MCP_SERVER_PREFIX}weather`,
        syntheticServer,
        commandMap
      )
    ).toBe(true);
  });

  it("keeps user-defined servers visible even with custom-tool prefix", () => {
    const commandMap = {
      [`${CUSTOM_TOOL_MCP_SERVER_PREFIX}weather`]: "'python' 'script.py'",
    };

    const userDefinedServer: MCPServerInfo = {
      transport: "stdio",
      command: "python script.py",
      disabled: false,
    };

    expect(
      shouldHideSyntheticCustomToolServer(
        `${CUSTOM_TOOL_MCP_SERVER_PREFIX}weather`,
        userDefinedServer,
        commandMap
      )
    ).toBe(false);
  });
});
