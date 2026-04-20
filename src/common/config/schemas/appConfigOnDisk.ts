import { z } from "zod";

import { AgentIdSchema, RuntimeEnablementIdSchema } from "../../schemas/ids";
import { ProjectConfigSchema } from "../../schemas/project";
import { RuntimeEnablementOverridesSchema } from "../../schemas/runtimeEnablement";
import { ThinkingLevelSchema } from "../../types/thinking";
import { CODER_ARCHIVE_BEHAVIORS } from "../coderArchiveBehavior";
import { WORKTREE_ARCHIVE_BEHAVIORS } from "../worktreeArchiveBehavior";
import { TaskSettingsSchema } from "./taskSettings";
import { HEARTBEAT_MAX_INTERVAL_MS, HEARTBEAT_MIN_INTERVAL_MS } from "@/constants/heartbeat";

export { RuntimeEnablementOverridesSchema } from "../../schemas/runtimeEnablement";
export type { RuntimeEnablementOverrides } from "../../schemas/runtimeEnablement";
export { PlanSubagentExecutorRoutingSchema, TaskSettingsSchema } from "./taskSettings";
export type { PlanSubagentExecutorRouting, TaskSettings } from "./taskSettings";

export const AgentAiDefaultsEntrySchema = z.object({
  modelString: z.string().optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  enabled: z.boolean().optional(),
  advisorEnabled: z.boolean().optional(),
});

export const AgentAiDefaultsSchema = z.record(AgentIdSchema, AgentAiDefaultsEntrySchema);

export const SubagentAiDefaultsEntrySchema = z.object({
  modelString: z.string().optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
});

export const SubagentAiDefaultsSchema = z.record(AgentIdSchema, SubagentAiDefaultsEntrySchema);

export const ToolsDefaultModeSchema = z.enum(["allow_all_except", "deny_all_except"]);

export const ToolsDefaultsSchema = z.object({
  mode: ToolsDefaultModeSchema,
  toolNames: z.array(z.string()),
});

export const CustomToolProvenanceSchema = z
  .object({
    links: z.array(z.string()).optional(),
    package: z.string().optional(),
  })
  .optional();

export const CustomToolSchema = z.object({
  id: z.string(),
  label: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  instructions: z.string().optional(),
  provenance: CustomToolProvenanceSchema,
  enabled: z.boolean().default(true),
});

export const ToolsConfigSchema = z.object({
  defaults: ToolsDefaultsSchema,
  custom: z.array(CustomToolSchema),
});

export const FeatureFlagOverrideSchema = z.enum(["default", "on", "off"]);

export const UpdateChannelSchema = z.enum(["stable", "nightly"]);

export const AppConfigOnDiskSchema = z
  .object({
    projects: z.array(z.tuple([z.string(), ProjectConfigSchema])).optional(),
    apiServerBindHost: z.string().optional(),
    apiServerPort: z.number().optional(),
    apiServerServeWebUi: z.boolean().optional(),
    mdnsAdvertisementEnabled: z.boolean().optional(),
    mdnsServiceName: z.string().optional(),
    serverSshHost: z.string().optional(),
    serverAuthGithubOwner: z.string().optional(),
    defaultProjectDir: z.string().optional(),
    viewedSplashScreens: z.array(z.string()).optional(),
    tools: ToolsConfigSchema.optional(),
    featureFlagOverrides: z.record(z.string(), FeatureFlagOverrideSchema).optional(),
    layoutPresets: z.unknown().optional(),
    taskSettings: TaskSettingsSchema.optional(),
    muxGatewayEnabled: z.boolean().optional(),
    llmDebugLogs: z.boolean().optional(),
    heartbeatDefaultPrompt: z.string().optional(),
    heartbeatDefaultIntervalMs: z
      .number()
      .int()
      .min(HEARTBEAT_MIN_INTERVAL_MS)
      .max(HEARTBEAT_MAX_INTERVAL_MS)
      .optional(),
    muxGatewayModels: z.array(z.string()).optional(),
    routePriority: z.array(z.string()).optional(),
    routeOverrides: z.record(z.string(), z.string()).optional(),
    defaultModel: z.string().optional(),
    advisorModelString: z.string().optional(),
    advisorThinkingLevel: ThinkingLevelSchema.optional(),
    advisorMaxUsesPerTurn: z.number().int().positive().nullable().optional(),
    advisorMaxOutputTokens: z.number().int().positive().nullable().optional(),
    hiddenModels: z.array(z.string()).optional(),
    preferredCompactionModel: z.string().optional(),
    agentAiDefaults: AgentAiDefaultsSchema.optional(),
    subagentAiDefaults: SubagentAiDefaultsSchema.optional(),
    useSSH2Transport: z.boolean().optional(),
    muxGovernorUrl: z.string().optional(),
    muxGovernorToken: z.string().optional(),
    coderWorkspaceArchiveBehavior: z.enum(CODER_ARCHIVE_BEHAVIORS).optional(),
    worktreeArchiveBehavior: z.enum(WORKTREE_ARCHIVE_BEHAVIORS).optional(),
    deleteWorktreeOnArchive: z.boolean().optional(),
    stopCoderWorkspaceOnArchive: z.boolean().optional(),
    terminalDefaultShell: z.string().optional(),
    updateChannel: UpdateChannelSchema.optional(),
    runtimeEnablement: RuntimeEnablementOverridesSchema.optional(),
    defaultRuntime: RuntimeEnablementIdSchema.optional(),
    onePasswordAccountName: z.string().optional(),
    tailscaleSsh: z
      .object({
        enabled: z.boolean().default(false),
        sshHost: z.string().optional(),
        username: z.string().optional(),
        proxyCommand: z.boolean().default(true),
      })
      .optional(),
  })
  .passthrough();

export type AgentAiDefaultsEntry = z.infer<typeof AgentAiDefaultsEntrySchema>;
export type AgentAiDefaults = z.infer<typeof AgentAiDefaultsSchema>;
export type SubagentAiDefaultsEntry = z.infer<typeof SubagentAiDefaultsEntrySchema>;
export type SubagentAiDefaults = z.infer<typeof SubagentAiDefaultsSchema>;
export type ToolsDefaultMode = z.infer<typeof ToolsDefaultModeSchema>;
export type ToolsDefaults = z.infer<typeof ToolsDefaultsSchema>;
export type CustomToolProvenance = z.infer<typeof CustomToolProvenanceSchema>;
export type CustomTool = z.infer<typeof CustomToolSchema>;
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type FeatureFlagOverride = z.infer<typeof FeatureFlagOverrideSchema>;
export type UpdateChannel = z.infer<typeof UpdateChannelSchema>;

export type AppConfigOnDisk = z.infer<typeof AppConfigOnDiskSchema>;
