import React, { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/browser/components/Button/Button";
import { Input } from "@/browser/components/Input/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { Switch } from "@/browser/components/Switch/Switch";
import { useAPI } from "@/browser/contexts/API";
import { cn } from "@/common/lib/utils";
import type { CustomTool, ToolsConfig, ToolsDefaultMode } from "@/common/config/schemas";

const DEFAULT_TOOLS_CONFIG: ToolsConfig = {
  defaults: {
    mode: "allow_all_except",
    toolNames: [],
  },
  custom: [],
};

const TEXTAREA_INPUT_CLASS =
  "border-input placeholder:text-muted focus-visible:ring-ring w-full rounded-md border bg-transparent px-3 py-2 text-sm leading-relaxed focus-visible:ring-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50";

function createNewCustomTool(): CustomTool {
  return {
    id: "",
    label: "",
    command: "",
    args: [],
    instructions: undefined,
    provenance: undefined,
    enabled: true,
  };
}

function parseCommaSeparatedValues(input: string): string[] {
  return input
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function parseMultilineValues(input: string): string[] {
  return input
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export interface ParsedArgInput {
  args: string[];
  error: string | null;
}

/**
 * Parse shell-like arg input while preserving quoted segments and escaped characters.
 * Supports single/double quotes plus escaping spaces/quotes via backslashes.
 */
export function parseQuotedArgInput(input: string): ParsedArgInput {
  const args: string[] = [];
  let current = "";
  let tokenStarted = false;
  let inSingleQuotes = false;
  let inDoubleQuotes = false;
  let escaping = false;

  const pushCurrent = () => {
    if (tokenStarted) {
      args.push(current);
      current = "";
      tokenStarted = false;
    }
  };

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && !inSingleQuotes) {
      escaping = true;
      tokenStarted = true;
      continue;
    }

    if (char === "'" && !inDoubleQuotes) {
      inSingleQuotes = !inSingleQuotes;
      tokenStarted = true;
      continue;
    }

    if (char === '"' && !inSingleQuotes) {
      inDoubleQuotes = !inDoubleQuotes;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char) && !inSingleQuotes && !inDoubleQuotes) {
      pushCurrent();
      continue;
    }

    current += char;
    tokenStarted = true;
  }

  if (escaping) {
    return {
      args,
      error: "Arguments cannot end with a trailing backslash.",
    };
  }

  if (inSingleQuotes || inDoubleQuotes) {
    return {
      args,
      error: "Close all quoted arguments before saving.",
    };
  }

  pushCurrent();
  return { args, error: null };
}

export function stringifyArgsForInput(args: string[]): string {
  return args
    .map((arg) => {
      if (arg.length === 0) {
        return '""';
      }

      if (!/[\s"'\\]/.test(arg)) {
        return arg;
      }

      return `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    })
    .join(" ");
}

function getDuplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
      continue;
    }
    seen.add(value);
  }

  return [...duplicates];
}

export function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

interface CustomToolFieldErrors {
  id: string | null;
  label: string | null;
  command: string | null;
  provenanceLinks: string | null;
}

interface CustomToolValidationResult {
  fieldErrors: CustomToolFieldErrors;
  blockingErrors: string[];
  warnings: string[];
}

const CUSTOM_TOOL_ID_PATTERN = /^[a-z0-9_-]+$/;

function getModeDescription(mode: ToolsDefaultMode): string {
  if (mode === "allow_all_except") {
    return "All tools are available by default. Names in the list are blocked globally.";
  }

  return "All tools are blocked by default. Only names in the list are globally allowed.";
}

function getValidationSummaryLabel(issueCount: number): string {
  if (issueCount === 0) {
    return "No validation issues";
  }

  return `${issueCount} validation issue${issueCount === 1 ? "" : "s"}`;
}

function buildCustomToolValidation(
  tool: CustomTool,
  duplicateCustomToolIds: string[]
): CustomToolValidationResult {
  const id = tool.id.trim();
  const label = tool.label.trim();
  const command = tool.command.trim();

  const links =
    tool.provenance?.links?.map((link) => link.trim()).filter((link) => link.length > 0) ?? [];
  const invalidLinks = links.filter((link) => !isValidUrl(link));

  let idError: string | null = null;
  if (id.length === 0) {
    idError = "Tool ID is required.";
  } else if (/\s/.test(id)) {
    idError = "Tool ID cannot include spaces.";
  } else if (!CUSTOM_TOOL_ID_PATTERN.test(id)) {
    idError = "Use lowercase letters, numbers, hyphens, or underscores.";
  } else if (duplicateCustomToolIds.includes(id)) {
    idError = `Tool ID "${id}" is duplicated.`;
  }

  const fieldErrors: CustomToolFieldErrors = {
    id: idError,
    label: label.length === 0 ? "Display label is required." : null,
    command: command.length === 0 ? "Command is required." : null,
    provenanceLinks:
      invalidLinks.length > 0
        ? `Invalid URL${invalidLinks.length > 1 ? "s" : ""}: ${invalidLinks.join(", ")}`
        : null,
  };

  const blockingErrors = [
    fieldErrors.id,
    fieldErrors.label,
    fieldErrors.command,
    fieldErrors.provenanceLinks,
  ].filter((message): message is string => message !== null);
  const warnings: string[] = [];

  return {
    fieldErrors,
    blockingErrors,
    warnings,
  };
}

function FieldLabel(props: {
  children: React.ReactNode;
  required?: boolean;
  htmlFor?: string;
  id?: string;
}) {
  return (
    <label htmlFor={props.htmlFor} id={props.id} className="text-muted mb-1 block text-xs">
      {props.children}
      {props.required ? <span className="text-foreground ml-0.5">*</span> : null}
    </label>
  );
}

function FieldError(props: { message: string | null }) {
  if (!props.message) {
    return null;
  }

  return <p className="text-error mt-1 text-xs">{props.message}</p>;
}

export function ToolsSettingsSection() {
  const { api } = useAPI();
  const [toolsConfig, setToolsConfig] = useState<ToolsConfig>(DEFAULT_TOOLS_CONFIG);
  const [toolNamesInput, setToolNamesInput] = useState("");
  const [customToolArgsInput, setCustomToolArgsInput] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api) {
      return;
    }

    setLoading(true);
    try {
      const config = await api.config.getConfig();
      const nextTools = config.tools ?? DEFAULT_TOOLS_CONFIG;
      setToolsConfig(nextTools);
      setToolNamesInput(nextTools.defaults.toolNames.join(", "));
      setCustomToolArgsInput(
        nextTools.custom.map((tool) => stringifyArgsForInput(tool.args ?? []))
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tools settings");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!api?.config?.onConfigChanged) {
      return;
    }

    let cancelled = false;
    const abortController = new AbortController();

    const subscribe = async () => {
      try {
        const stream = await api.config.onConfigChanged(undefined, {
          signal: abortController.signal,
        });
        for await (const _event of stream) {
          if (cancelled) {
            break;
          }
          await load();
        }
      } catch {
        // Best-effort subscription.
      }
    };

    void subscribe();

    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [api, load]);

  const updateMode = useCallback((mode: ToolsDefaultMode) => {
    setToolsConfig((prev) => ({
      ...prev,
      defaults: {
        ...prev.defaults,
        mode,
      },
    }));
  }, []);

  const updateCustomTool = useCallback(
    (index: number, updater: (tool: CustomTool) => CustomTool) => {
      setToolsConfig((prev) => ({
        ...prev,
        custom: prev.custom.map((tool, toolIndex) => (toolIndex === index ? updater(tool) : tool)),
      }));
    },
    []
  );

  const addCustomTool = useCallback(() => {
    setToolsConfig((prev) => ({
      ...prev,
      custom: [...prev.custom, createNewCustomTool()],
    }));
    setCustomToolArgsInput((prev) => [...prev, ""]);
  }, []);

  const removeCustomTool = useCallback((index: number) => {
    setToolsConfig((prev) => ({
      ...prev,
      custom: prev.custom.filter((_, toolIndex) => toolIndex !== index),
    }));
    setCustomToolArgsInput((prev) => prev.filter((_, inputIndex) => inputIndex !== index));
  }, []);

  const parsedToolNames = parseCommaSeparatedValues(toolNamesInput);
  const duplicateToolNames = getDuplicateValues(parsedToolNames);

  const duplicateCustomToolIds = getDuplicateValues(
    toolsConfig.custom.map((tool) => tool.id.trim()).filter((toolId) => toolId.length > 0)
  );

  const customToolValidation = toolsConfig.custom.map((tool) =>
    buildCustomToolValidation(tool, duplicateCustomToolIds)
  );

  const parsedCustomToolArgs = toolsConfig.custom.map((_, index) =>
    parseQuotedArgInput(customToolArgsInput[index] ?? "")
  );

  const totalValidationIssueCount =
    duplicateToolNames.length +
    parsedCustomToolArgs.filter((parsedArgs) => parsedArgs.error !== null).length +
    customToolValidation.reduce((count, validation) => count + validation.blockingErrors.length, 0);

  const hasBlockingValidationError = totalValidationIssueCount > 0;

  const save = useCallback(async () => {
    if (!api?.config?.updateToolsConfig) {
      return;
    }

    if (hasBlockingValidationError) {
      setError("Fix validation issues before saving tools settings.");
      return;
    }

    const payload: ToolsConfig = {
      defaults: {
        mode: toolsConfig.defaults.mode,
        toolNames: parsedToolNames,
      },
      custom: toolsConfig.custom.map((tool, index) => {
        const trimmedProvenancePackage = tool.provenance?.package?.trim() ?? "";
        const trimmedProvenanceLinks =
          tool.provenance?.links?.map((link) => link.trim()).filter((link) => link.length > 0) ??
          [];

        const trimmedInstructions = tool.instructions?.trim() ?? "";

        return {
          ...tool,
          id: tool.id.trim(),
          label: tool.label.trim(),
          command: tool.command.trim(),
          args: parsedCustomToolArgs[index]?.args ?? [],
          instructions: trimmedInstructions.length > 0 ? trimmedInstructions : undefined,
          provenance:
            trimmedProvenancePackage.length > 0 || trimmedProvenanceLinks.length > 0
              ? {
                  package:
                    trimmedProvenancePackage.length > 0 ? trimmedProvenancePackage : undefined,
                  links: trimmedProvenanceLinks,
                }
              : undefined,
        };
      }),
    };

    setSaving(true);
    try {
      await api.config.updateToolsConfig({ tools: payload });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save tools settings");
    } finally {
      setSaving(false);
    }
  }, [api, hasBlockingValidationError, parsedCustomToolArgs, parsedToolNames, toolsConfig]);

  return (
    <div className="space-y-6">
      <div className="border-border-medium bg-background-secondary space-y-2 rounded-md border p-4">
        <h3 className="text-foreground text-sm font-medium">Tool access and custom tools</h3>
        <p className="text-muted text-xs leading-relaxed">
          Configure global tool defaults and command-backed custom tools stored in{" "}
          <code>~/.mux/config.json</code>.
        </p>
        <ul className="text-muted list-disc space-y-1 pl-4 text-xs leading-relaxed">
          <li>Global defaults control baseline tool access for all agents.</li>
          <li>Custom tools register reusable MCP stdio commands by tool ID.</li>
        </ul>
      </div>

      {error && <p className="text-error text-sm">{error}</p>}

      <div className="border-border-medium bg-background-secondary space-y-4 rounded-md border p-4">
        <div>
          <h3 className="text-foreground text-sm font-medium">Global defaults</h3>
          <p className="text-muted mt-1 text-xs">
            Set the default policy and which tool names it applies to.
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-[220px_1fr] md:items-center">
          <FieldLabel id="tools-default-mode-label" required>
            Default mode
          </FieldLabel>
          <div className="space-y-2">
            <Select
              value={toolsConfig.defaults.mode}
              onValueChange={(value) => updateMode(value as ToolsDefaultMode)}
            >
              <SelectTrigger
                className="w-full max-w-[320px]"
                aria-labelledby="tools-default-mode-label"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="allow_all_except">Allow all except listed tools</SelectItem>
                <SelectItem value="deny_all_except">Deny all except listed tools</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-muted text-xs">{getModeDescription(toolsConfig.defaults.mode)}</p>
          </div>
        </div>

        <div>
          <FieldLabel htmlFor="tools-default-tool-names">
            Tool name list (comma-separated)
          </FieldLabel>
          <Input
            id="tools-default-tool-names"
            value={toolNamesInput}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
              setToolNamesInput(event.target.value)
            }
            placeholder="bash, file_edit_replace_string"
            aria-invalid={duplicateToolNames.length > 0}
          />
          <p className="text-muted mt-1 text-xs">
            Use exact tool names. This list is interpreted by the selected mode as an allowlist or
            blocklist.
          </p>
          {duplicateToolNames.length > 0 ? (
            <p className="text-error mt-1 text-xs">
              Remove duplicate tool names: {duplicateToolNames.join(", ")}
            </p>
          ) : null}
          {parsedToolNames.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {parsedToolNames.map((toolName, toolNameIndex) => (
                <span
                  key={`default-tool-${toolName}-${toolNameIndex}`}
                  className="border-border-medium bg-background rounded px-1.5 py-0.5 text-[11px]"
                >
                  {toolName}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-muted mt-2 text-xs">No tool names listed.</p>
          )}
        </div>
      </div>

      <div className="border-border-medium bg-background-secondary space-y-4 rounded-md border p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-foreground text-sm font-medium">Custom tools</h3>
            <p className="text-muted mt-1 text-xs leading-relaxed">
              Add command-backed tools that agents can call by ID when enabled. Each custom tool
              requires a unique Tool ID, label, and command.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={addCustomTool}>
            <Plus className="h-4 w-4" />
            Add custom tool
          </Button>
        </div>

        <div className="border-border-medium bg-background rounded-md border px-3 py-2">
          {hasBlockingValidationError ? (
            <p className="text-error text-xs">
              {getValidationSummaryLabel(totalValidationIssueCount)}. Resolve all issues before
              saving.
            </p>
          ) : (
            <p className="text-muted text-xs">
              {getValidationSummaryLabel(totalValidationIssueCount)}. Required fields are marked
              with
              <span className="text-foreground ml-0.5">*</span>.
            </p>
          )}
        </div>
        {toolsConfig.custom.length === 0 ? (
          <p className="text-muted rounded-md border border-dashed px-3 py-2 text-sm">
            No custom tools configured.
          </p>
        ) : (
          <div className="space-y-3">
            {toolsConfig.custom.map((tool, index) => {
              const validation = customToolValidation[index];
              const fieldErrors = validation.fieldErrors;
              const argsValidation = parsedCustomToolArgs[index] ?? { args: [], error: null };
              const linksInputValue = (tool.provenance?.links ?? []).join("\n");
              const blockingIssueCount =
                validation.blockingErrors.length + (argsValidation.error ? 1 : 0);
              const warningCount = validation.warnings.length;
              const toolIdInputId = `custom-tool-id-${index}`;
              const toolLabelInputId = `custom-tool-label-${index}`;
              const toolCommandInputId = `custom-tool-command-${index}`;
              const toolArgsInputId = `custom-tool-args-${index}`;
              const toolInstructionsInputId = `custom-tool-instructions-${index}`;
              const toolProvenancePackageInputId = `custom-tool-provenance-package-${index}`;
              const toolProvenanceLinksInputId = `custom-tool-provenance-links-${index}`;

              return (
                <div
                  // Keep row keys stable while editing IDs so inputs preserve focus/cursor state.
                  key={`custom-tool-row-${index}`}
                  className={cn(
                    "bg-background space-y-3 rounded-md border p-3",
                    blockingIssueCount > 0
                      ? "border-error/40"
                      : warningCount > 0
                        ? "border-warning/40"
                        : "border-border-medium"
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-1">
                      <p className="text-foreground text-sm font-medium">
                        {tool.label.trim() || `Custom tool ${index + 1}`}
                      </p>
                      <p className="text-muted text-xs">
                        ID: <code>{tool.id.trim() || "(not set)"}</code>
                      </p>
                      {blockingIssueCount > 0 ? (
                        <p className="text-error text-xs">
                          {blockingIssueCount} required field{blockingIssueCount === 1 ? "" : "s"}{" "}
                          still need attention.
                        </p>
                      ) : warningCount > 0 ? (
                        <p className="text-warning text-xs">
                          {warningCount} optional warning{warningCount === 1 ? "" : "s"}.
                        </p>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={cn("text-xs", tool.enabled ? "text-foreground" : "text-muted")}
                      >
                        {tool.enabled ? "Enabled" : "Disabled"}
                      </span>
                      <Switch
                        checked={tool.enabled}
                        onCheckedChange={(checked) =>
                          updateCustomTool(index, (prev) => ({
                            ...prev,
                            enabled: checked,
                          }))
                        }
                        aria-label={`Toggle custom tool ${index + 1}`}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeCustomTool(index)}
                        aria-label={`Remove custom tool ${index + 1}`}
                        title="Remove custom tool"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div>
                      <FieldLabel htmlFor={toolIdInputId} required>
                        Tool ID
                      </FieldLabel>
                      <Input
                        id={toolIdInputId}
                        value={tool.id}
                        onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                          updateCustomTool(index, (prev) => ({ ...prev, id: event.target.value }))
                        }
                        placeholder="weather_lookup"
                        aria-invalid={fieldErrors.id !== null}
                      />
                      <p className="text-muted mt-1 text-xs">
                        Used in prompts and tool routing. Prefer lowercase with <code>-</code> or
                        <code>_</code>.
                      </p>
                      <FieldError message={fieldErrors.id} />
                    </div>

                    <div>
                      <FieldLabel htmlFor={toolLabelInputId} required>
                        Label
                      </FieldLabel>
                      <Input
                        id={toolLabelInputId}
                        value={tool.label}
                        onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                          updateCustomTool(index, (prev) => ({
                            ...prev,
                            label: event.target.value,
                          }))
                        }
                        placeholder="Weather Lookup"
                        aria-invalid={fieldErrors.label !== null}
                      />
                      <p className="text-muted mt-1 text-xs">Human-readable name shown in UI.</p>
                      <FieldError message={fieldErrors.label} />
                    </div>
                  </div>

                  <div>
                    <FieldLabel htmlFor={toolCommandInputId} required>
                      Command
                    </FieldLabel>
                    <Input
                      id={toolCommandInputId}
                      value={tool.command}
                      onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                        updateCustomTool(index, (prev) => ({
                          ...prev,
                          command: event.target.value,
                        }))
                      }
                      placeholder="python"
                      aria-invalid={fieldErrors.command !== null}
                    />
                    <p className="text-muted mt-1 text-xs">
                      Executable launched through MCP stdio.
                    </p>
                    <FieldError message={fieldErrors.command} />
                  </div>

                  <div>
                    <FieldLabel htmlFor={toolArgsInputId}>Args (quote-aware)</FieldLabel>
                    <Input
                      id={toolArgsInputId}
                      value={customToolArgsInput[index] ?? ""}
                      onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                        setCustomToolArgsInput((prev) => {
                          const next = [...prev];
                          next[index] = event.target.value;
                          return next;
                        });
                      }}
                      onBlur={() => {
                        const parsed = parsedCustomToolArgs[index];
                        if (parsed?.error) {
                          return;
                        }
                        setCustomToolArgsInput((prev) => {
                          const next = [...prev];
                          next[index] = stringifyArgsForInput(parsed?.args ?? []);
                          return next;
                        });
                      }}
                      placeholder='server.py --mode "safe sandbox"'
                      aria-invalid={argsValidation.error !== null}
                    />
                    <p className="text-muted mt-1 text-xs leading-relaxed">
                      Use quotes for values with spaces, for example{" "}
                      <code>&quot;s3://my bucket&quot;</code>. Backslashes escape spaces and quotes.
                    </p>
                    <FieldError message={argsValidation.error} />
                    {argsValidation.args.length > 0 ? (
                      <div className="mt-2 space-y-1">
                        <p className="text-muted text-xs">
                          Parsed args ({argsValidation.args.length})
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {argsValidation.args.map((arg, argIndex) => (
                            <span
                              key={`custom-tool-arg-${index}-${argIndex}`}
                              className="border-border-medium bg-background-secondary rounded px-1.5 py-0.5 text-[11px]"
                            >
                              {arg.length > 0 ? arg : "(empty)"}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <div>
                    <FieldLabel htmlFor={toolInstructionsInputId}>Instructions</FieldLabel>
                    <textarea
                      id={toolInstructionsInputId}
                      value={tool.instructions ?? ""}
                      onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
                        updateCustomTool(index, (prev) => ({
                          ...prev,
                          instructions: event.target.value || undefined,
                        }))
                      }
                      placeholder="When to use this tool and what inputs it expects"
                      rows={3}
                      className={TEXTAREA_INPUT_CLASS}
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div>
                      <FieldLabel htmlFor={toolProvenancePackageInputId}>
                        Provenance package
                      </FieldLabel>
                      <Input
                        id={toolProvenancePackageInputId}
                        value={tool.provenance?.package ?? ""}
                        onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                          updateCustomTool(index, (prev) => ({
                            ...prev,
                            provenance: {
                              ...(prev.provenance ?? {}),
                              package: event.target.value || undefined,
                            },
                          }))
                        }
                        placeholder="@acme/weather-tool"
                      />
                    </div>

                    <div>
                      <FieldLabel htmlFor={toolProvenanceLinksInputId}>
                        Provenance links (one per line)
                      </FieldLabel>
                      <textarea
                        id={toolProvenanceLinksInputId}
                        value={linksInputValue}
                        onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
                          updateCustomTool(index, (prev) => ({
                            ...prev,
                            provenance: {
                              ...(prev.provenance ?? {}),
                              links: parseMultilineValues(event.target.value),
                            },
                          }))
                        }
                        placeholder={
                          "https://github.com/acme/weather-tool\nhttps://docs.acme.dev/tool"
                        }
                        rows={3}
                        className={TEXTAREA_INPUT_CLASS}
                      />
                      {fieldErrors.provenanceLinks ? (
                        <p className="text-error mt-1 text-xs">{fieldErrors.provenanceLinks}</p>
                      ) : (
                        <p className="text-muted mt-1 text-xs">
                          Optional source links for traceability.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="border-border-medium bg-background-secondary flex flex-wrap items-center gap-2 rounded-md border px-4 py-3">
        <Button
          onClick={() => void save()}
          disabled={loading || saving || hasBlockingValidationError}
        >
          {saving ? "Saving…" : "Save tools settings"}
        </Button>
        <Button variant="outline" onClick={() => void load()} disabled={loading || saving}>
          Reload from disk
        </Button>
        {hasBlockingValidationError ? (
          <p className="text-error text-xs">
            {getValidationSummaryLabel(totalValidationIssueCount)}. Resolve all issues before
            saving.
          </p>
        ) : (
          <p className="text-muted text-xs">
            Changes are saved globally and apply to all workspaces.
          </p>
        )}
      </div>
    </div>
  );
}
