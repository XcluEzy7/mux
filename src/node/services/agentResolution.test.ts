import { describe, expect, it } from "bun:test";

import { applyToolPolicyToNames } from "@/common/utils/tools/toolPolicy";
import type { ProjectsConfig } from "@/common/types/project";
import { buildGlobalToolsPolicy, composeEffectiveToolPolicy } from "./agentResolution";

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

    expect(buildGlobalToolsPolicy(config)).toEqual([{ action: "disable", regex_match: "^bash$" }]);
  });

  it("builds deny_all_except blanket disable rule for an empty allowlist", () => {
    const config = createBaseConfig();
    config.tools = {
      defaults: {
        mode: "deny_all_except",
        toolNames: [],
      },
      custom: [],
    };

    expect(buildGlobalToolsPolicy(config)).toEqual([{ action: "disable", regex_match: ".*" }]);
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
      { action: "enable", regex_match: "^file_read$" },
      { action: "enable", regex_match: "^mcp\\.server\\.tool\\+name$" },
    ]);
  });
});

describe("composeEffectiveToolPolicy", () => {
  it("keeps runtime hard-deny precedence over global allow defaults", () => {
    const policy = composeEffectiveToolPolicy({
      globalToolsPolicy: [{ action: "enable", regex_match: "^bash$" }],
      agentToolPolicy: [{ action: "disable", regex_match: "bash" }],
      callerToolPolicy: undefined,
    });

    expect(applyToolPolicyToNames(["bash"], policy)).toEqual([]);
  });

  it("drops agent require rules when caller provides its own required tool", () => {
    const policy = composeEffectiveToolPolicy({
      globalToolsPolicy: [],
      agentToolPolicy: [{ action: "require", regex_match: "agent_report" }],
      callerToolPolicy: [{ action: "require", regex_match: "task" }],
    });

    expect(policy).toEqual([{ action: "require", regex_match: "task" }]);
  });
});
