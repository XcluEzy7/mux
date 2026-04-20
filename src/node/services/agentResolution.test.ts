import { describe, expect, it } from "bun:test";

import type { ProjectsConfig } from "@/common/types/project";
import { buildGlobalToolsPolicy } from "./agentResolution";

function createBaseConfig(): ProjectsConfig {
  return {
    projects: new Map(),
  };
}

describe("buildGlobalToolsPolicy", () => {
  it("returns empty policy when tool defaults are missing", () => {
    expect(buildGlobalToolsPolicy(createBaseConfig())).toEqual([]);
  });

  it("builds allow_all_except disable filters", () => {
    const config = createBaseConfig();
    config.tools = {
      defaults: {
        mode: "allow_all_except",
        toolNames: ["bash", "bash", ""],
      },
      custom: [],
    };

    expect(buildGlobalToolsPolicy(config)).toEqual([{ action: "disable", regex_match: "bash" }]);
  });

  it("builds deny_all_except with escaped names", () => {
    const config = createBaseConfig();
    config.tools = {
      defaults: {
        mode: "deny_all_except",
        toolNames: ["file_read", "mcp.server.tool+name"],
      },
      custom: [],
    };

    expect(buildGlobalToolsPolicy(config)).toEqual([
      { action: "disable", regex_match: ".*" },
      { action: "enable", regex_match: "file_read" },
      { action: "enable", regex_match: "mcp\\.server\\.tool\\+name" },
    ]);
  });
});
