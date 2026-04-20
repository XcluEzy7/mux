/**
 * Agent resolution: resolves the active agent and computes tool policy for a stream.
 *
 * Extracted from `streamMessage()` to make the agent resolution logic
 * explicit and testable. Contains:
 * - Agent ID normalization & fallback to exec
 * - Agent definition loading with error recovery
 * - Disabled-agent enforcement (subagent workspaces error, top-level falls back)
 * - Inheritance chain resolution + plan-like detection
 * - Task nesting depth enforcement
 * - Tool policy composition (agent → caller)
 */

import { AgentIdSchema } from "@/common/orpc/schemas";
import type { SendMessageError } from "@/common/types/errors";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import type { ErrorEvent } from "@/common/types/stream";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import type { ProjectsConfig } from "@/common/types/project";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { isPlanLikeInResolvedChain } from "@/common/utils/agentTools";
import { getErrorMessage } from "@/common/utils/errors";
import { type ToolPolicy } from "@/common/utils/tools/toolPolicy";
import type { Runtime } from "@/node/runtime/Runtime";
import {
  getSkipScopesAboveForKnownScope,
  readAgentDefinition,
  resolveAgentFrontmatter,
} from "@/node/services/agentDefinitions/agentDefinitionsService";
import { isAgentEffectivelyDisabled } from "@/node/services/agentDefinitions/agentEnablement";
import { resolveAgentInheritanceChain } from "@/node/services/agentDefinitions/resolveAgentInheritanceChain";
import { resolveToolPolicyForAgent } from "@/node/services/agentDefinitions/resolveToolPolicy";
import { log } from "./log";
import { getTaskDepthFromConfig } from "./taskUtils";
import { createAssistantMessageId } from "./utils/messageIds";
import { createErrorEvent } from "./utils/sendMessageError";

function escapeToolNameForRegex(toolName: string): string {
  return toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildLiteralToolNameRegex(toolName: string): string {
  // regex_match is anchored by the tool policy evaluator (`^...$`).
  // Keep this value unanchored so names are not double-anchored.
  return escapeToolNameForRegex(toolName);
}

export function buildGlobalToolsPolicy(cfg: ProjectsConfig): ToolPolicy {
  const toolsDefaults = cfg.tools?.defaults;
  if (!toolsDefaults) {
    return [];
  }

  const validToolNames = Array.from(
    new Set(
      (toolsDefaults.toolNames ?? []).map((name) => name.trim()).filter((name) => name.length > 0)
    )
  );

  if (toolsDefaults.mode === "deny_all_except") {
    return [
      { action: "disable", regex_match: ".*" },
      ...validToolNames.map((name) => ({
        action: "enable" as const,
        regex_match: buildLiteralToolNameRegex(name),
      })),
    ];
  }

  return validToolNames.map((name) => ({
    action: "disable" as const,
    regex_match: buildLiteralToolNameRegex(name),
  }));
}

export interface ComposeEffectiveToolPolicyOptions {
  agentToolPolicy: ToolPolicy;
  callerToolPolicy: ToolPolicy | undefined;
  globalToolsPolicy: ToolPolicy;
}

const RUNTIME_SAFETY_TOOL_POLICY_KEYS = new Set([
  "disable:task",
  "disable:task_.*",
  "disable:ask_user_question",
  "disable:switch_agent",
  "disable:propose_plan",
  "disable:agent_report",
  "require:switch_agent",
  "require:propose_plan",
  "require:agent_report",
  "enable:advisor",
  "disable:advisor",
]);

function isRuntimeSafetyPolicyFilter(filter: ToolPolicy[number]): boolean {
  return RUNTIME_SAFETY_TOOL_POLICY_KEYS.has(`${filter.action}:${filter.regex_match}`);
}

export function composeEffectiveToolPolicy({
  agentToolPolicy,
  callerToolPolicy,
  globalToolsPolicy,
}: ComposeEffectiveToolPolicyOptions): ToolPolicy | undefined {
  const runtimeSafetyPolicy = agentToolPolicy.filter(isRuntimeSafetyPolicyFilter);
  const agentPolicyWithoutRuntimeSafety = agentToolPolicy.filter(
    (filter) => !isRuntimeSafetyPolicyFilter(filter)
  );

  const callerRequiresTool =
    callerToolPolicy?.some((filter) => filter.action === "require") === true;
  const runtimeRequiresTool =
    runtimeSafetyPolicy.some((filter) => filter.action === "require") === true;

  // Caller require policies can override agent-authored require patterns, but runtime safety
  // requirements (subagent completion, switch_agent gating) remain authoritative.
  const agentPolicyForComposition = callerRequiresTool
    ? agentPolicyWithoutRuntimeSafety.filter((filter) => filter.action !== "require")
    : agentPolicyWithoutRuntimeSafety;
  const callerPolicyForComposition =
    callerRequiresTool && runtimeRequiresTool
      ? callerToolPolicy?.filter((filter) => filter.action !== "require")
      : callerToolPolicy;

  // Order of precedence (last matching filter wins):
  // 1) agent-authored defaults
  // 2) global defaults from config
  // 3) runtime safety constraints (must not be overridden)
  // 4) caller restrictions
  const composedPolicy = [
    ...agentPolicyForComposition,
    ...globalToolsPolicy,
    ...runtimeSafetyPolicy,
    ...(callerPolicyForComposition ?? []),
  ];

  return composedPolicy.length > 0 ? composedPolicy : undefined;
}

/** Options for agent resolution. */
export interface ResolveAgentOptions {
  workspaceId: string;
  metadata: WorkspaceMetadata;
  runtime: Runtime;
  workspacePath: string;
  /** Requested agent ID from the frontend (may be undefined → defaults to exec). */
  requestedAgentId: string | undefined;
  /** When true, skip workspace-specific agents (for "unbricking" broken agent files). */
  disableWorkspaceAgents: boolean;
  /** Caller-supplied tool policy (applied AFTER agent policy for further restriction). */
  callerToolPolicy: ToolPolicy | undefined;
  /** Loaded config from Config.loadConfigOrDefault(). */
  cfg: ProjectsConfig;
  /** Emit an error event on the AIService EventEmitter (for disabled-agent subagent errors). */
  emitError: (event: ErrorEvent) => void;
  /** Whether the advisor-tool experiment is enabled (from ExperimentsService). */
  isAdvisorExperimentEnabled?: boolean;
}

/** Result of agent resolution — all computed values needed by the stream pipeline. */
export interface AgentResolutionResult {
  effectiveAgentId: string;
  agentDefinition: Awaited<ReturnType<typeof readAgentDefinition>>;
  /** Path used for agent discovery (workspace path or project path if agents disabled). */
  agentDiscoveryPath: string;
  isSubagentWorkspace: boolean;
  /** Whether the resolved agent inherits plan-like behavior (has propose_plan in tool chain). */
  agentIsPlanLike: boolean;
  effectiveMode: "plan" | "exec" | "compact";
  taskSettings: ProjectsConfig["taskSettings"] & {};
  taskDepth: number;
  shouldDisableTaskToolsForDepth: boolean;
  /** Composed tool policy: agent → caller (in application order). */
  effectiveToolPolicy: ToolPolicy | undefined;
}

/**
 * Resolve the active agent and compute tool policy for a stream request.
 *
 * This is the first major phase of `streamMessage()` after workspace/runtime setup.
 * It determines which agent definition to use, whether plan mode is active, and what
 * tools are available (via policy). The result feeds into system prompt construction
 * and tool assembly.
 *
 * Returns `Err` only when a disabled agent is requested in a subagent workspace
 * (top-level workspaces silently fall back to exec).
 */
export async function resolveAgentForStream(
  opts: ResolveAgentOptions
): Promise<Result<AgentResolutionResult, SendMessageError>> {
  const {
    workspaceId,
    metadata,
    runtime,
    workspacePath,
    requestedAgentId: rawAgentId,
    disableWorkspaceAgents,
    callerToolPolicy,
    cfg,
    emitError,
    isAdvisorExperimentEnabled,
  } = opts;

  const workspaceLog = log.withFields({ workspaceId, workspaceName: metadata.name });

  // --- Agent ID resolution ---
  // Precedence:
  // - Child workspaces (tasks) use their persisted agentId/agentType.
  // - Main workspaces use the requested agentId (frontend), falling back to exec.
  const requestedAgentIdRaw =
    (metadata.parentWorkspaceId ? (metadata.agentId ?? metadata.agentType) : undefined) ??
    (typeof rawAgentId === "string" ? rawAgentId : undefined) ??
    "exec";
  const requestedAgentIdNormalized = requestedAgentIdRaw.trim().toLowerCase();
  const parsedAgentId = AgentIdSchema.safeParse(requestedAgentIdNormalized);
  const requestedAgentId = parsedAgentId.success ? parsedAgentId.data : ("exec" as const);
  let effectiveAgentId = requestedAgentId;

  // When disableWorkspaceAgents is true, skip workspace-specific agents entirely.
  // Use project path so only built-in/global agents are available. This allows "unbricking"
  // when iterating on agent files — a broken agent in the worktree won't affect message sending.
  const agentDiscoveryPath = disableWorkspaceAgents ? metadata.projectPath : workspacePath;

  const isSubagentWorkspace = Boolean(metadata.parentWorkspaceId);

  // --- Load agent definition (with fallback to exec) ---
  let agentDefinition;
  try {
    agentDefinition = await readAgentDefinition(runtime, agentDiscoveryPath, effectiveAgentId);
  } catch (error) {
    workspaceLog.warn("Failed to load agent definition; falling back", {
      effectiveAgentId,
      agentDiscoveryPath,
      disableWorkspaceAgents,
      error: getErrorMessage(error),
    });
    agentDefinition = await readAgentDefinition(runtime, agentDiscoveryPath, "exec");
  }

  // Keep agent ID aligned with the actual definition used (may fall back to exec).
  effectiveAgentId = agentDefinition.id;

  // --- Disabled-agent enforcement ---
  // Disabled agents should never run as sub-agents, even if a task workspace already exists
  // on disk (e.g., config changed since creation).
  // For top-level workspaces, fall back to exec to keep the workspace usable.
  if (agentDefinition.id !== "exec") {
    try {
      const resolvedFrontmatter = await resolveAgentFrontmatter(
        runtime,
        agentDiscoveryPath,
        agentDefinition.id,
        {
          skipScopesAbove: getSkipScopesAboveForKnownScope(agentDefinition.scope),
        }
      );

      const effectivelyDisabled = isAgentEffectivelyDisabled({
        cfg,
        agentId: agentDefinition.id,
        resolvedFrontmatter,
      });

      if (effectivelyDisabled) {
        const errorMessage = `Agent '${agentDefinition.id}' is disabled.`;

        if (isSubagentWorkspace) {
          const errorMessageId = createAssistantMessageId();
          emitError(
            createErrorEvent(workspaceId, {
              messageId: errorMessageId,
              error: errorMessage,
              errorType: "unknown",
            })
          );
          return Err({ type: "unknown", raw: errorMessage });
        }

        workspaceLog.warn("Selected agent is disabled; falling back to exec", {
          agentId: agentDefinition.id,
          requestedAgentId,
        });
        agentDefinition = await readAgentDefinition(runtime, agentDiscoveryPath, "exec");
        effectiveAgentId = agentDefinition.id;
      }
    } catch (error: unknown) {
      // Best-effort only — do not fail a stream due to disablement resolution.
      workspaceLog.debug("Failed to resolve agent enablement; continuing", {
        agentId: agentDefinition.id,
        error: getErrorMessage(error),
      });
    }
  }

  // --- Inheritance chain & plan-like detection ---
  const agentsForInheritance = await resolveAgentInheritanceChain({
    runtime,
    workspacePath: agentDiscoveryPath,
    agentId: agentDefinition.id,
    agentDefinition,
    workspaceId,
  });

  const agentIsPlanLike = isPlanLikeInResolvedChain(agentsForInheritance);
  const effectiveMode =
    agentDefinition.id === "compact" ? "compact" : agentIsPlanLike ? "plan" : "exec";

  // --- Task nesting depth enforcement ---
  const taskSettings = cfg.taskSettings ?? DEFAULT_TASK_SETTINGS;
  const taskDepth = getTaskDepthFromConfig(cfg, workspaceId);
  const shouldDisableTaskToolsForDepth = taskDepth >= taskSettings.maxTaskNestingDepth;

  // --- Tool policy composition ---
  // Agent policy establishes baseline (deny-all + enable whitelist + runtime restrictions).
  // Caller policy then narrows further if needed.
  const advisorEnabled =
    isAdvisorExperimentEnabled === true &&
    cfg.agentAiDefaults?.[effectiveAgentId]?.advisorEnabled === true;
  const agentToolPolicy = resolveToolPolicyForAgent({
    agents: agentsForInheritance,
    isSubagent: isSubagentWorkspace,
    disableTaskToolsForDepth: shouldDisableTaskToolsForDepth,
    advisorEnabled,
  });

  const globalToolsPolicy = buildGlobalToolsPolicy(cfg);
  const effectiveToolPolicy = composeEffectiveToolPolicy({
    agentToolPolicy,
    callerToolPolicy,
    globalToolsPolicy,
  });

  return Ok({
    effectiveAgentId,
    agentDefinition,
    agentDiscoveryPath,
    isSubagentWorkspace,
    agentIsPlanLike,
    effectiveMode,
    taskSettings,
    taskDepth,
    shouldDisableTaskToolsForDepth,
    effectiveToolPolicy,
  });
}
