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

function parseSpaceSeparatedValues(input: string): string[] {
  return input
    .split(/\s+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
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

function isValidUrl(url: string): boolean {
  try {
    // URL constructor supports both http(s) and other URI schemes that users may rely on.
    new URL(url);
    return true;
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

function getModeDescription(mode: ToolsDefaultMode): string {
  if (mode === "allow_all_except") {
    return "All tools are available by default. Names in the list are blocked globally.";
  }

  return "All tools are blocked by default. Only names in the list are globally allowed.";
}

function FieldLabel(props: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="text-muted mb-1 block text-xs">
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
  }, []);

  const removeCustomTool = useCallback((index: number) => {
    setToolsConfig((prev) => ({
      ...prev,
      custom: prev.custom.filter((_, toolIndex) => toolIndex !== index),
    }));
  }, []);

  const parsedToolNames = parseCommaSeparatedValues(toolNamesInput);
  const duplicateToolNames = getDuplicateValues(parsedToolNames);

  const duplicateCustomToolIds = getDuplicateValues(
    toolsConfig.custom.map((tool) => tool.id.trim()).filter((toolId) => toolId.length > 0)
  );

  const customToolValidation: CustomToolFieldErrors[] = toolsConfig.custom.map((tool) => {
    const id = tool.id.trim();
    const label = tool.label.trim();
    const command = tool.command.trim();

    const links = (tool.provenance?.links ?? []).filter((link) => link.trim().length > 0);
    const invalidLinks = links.filter((link) => !isValidUrl(link));

    return {
      id:
        id.length === 0
          ? "Tool ID is required."
          : duplicateCustomToolIds.includes(id)
            ? `Tool ID "${id}" is duplicated.`
            : null,
      label: label.length === 0 ? "Display label is required." : null,
      command: command.length === 0 ? "Command is required." : null,
      provenanceLinks:
        invalidLinks.length > 0
          ? `Invalid URL${invalidLinks.length > 1 ? "s" : ""}: ${invalidLinks.join(", ")}`
          : null,
    };
  });

  const hasBlockingValidationError =
    duplicateToolNames.length > 0 ||
    customToolValidation.some((validation) =>
      [validation.id, validation.label, validation.command].some((message) => message !== null)
    );

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
      custom: toolsConfig.custom,
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
  }, [api, hasBlockingValidationError, parsedToolNames, toolsConfig]);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-muted text-xs">
          Configure global tool defaults and custom tools stored in <code>~/.mux/config.json</code>.
        </p>
        <ul className="text-muted list-disc space-y-1 pl-4 text-xs">
          <li>Global defaults control baseline tool access for all agents.</li>
          <li>Custom tools define reusable commands exposed as tool calls via MCP stdio.</li>
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
          <FieldLabel required>Default mode</FieldLabel>
          <div className="space-y-2">
            <Select
              value={toolsConfig.defaults.mode}
              onValueChange={(value) => updateMode(value as ToolsDefaultMode)}
            >
              <SelectTrigger className="w-full max-w-[320px]">
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
          <FieldLabel>Tool name list (comma-separated)</FieldLabel>
          <Input
            value={toolNamesInput}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
              setToolNamesInput(event.target.value)
            }
            placeholder="bash, file_edit_replace_string"
            aria-invalid={duplicateToolNames.length > 0}
          />
          <p className="text-muted mt-1 text-xs">
            Use exact tool names. This list is interpreted by the selected mode as allowlist or
            denylist.
          </p>
          {duplicateToolNames.length > 0 ? (
            <p className="text-error mt-1 text-xs">
              Remove duplicate tool names: {duplicateToolNames.join(", ")}
            </p>
          ) : null}
          {parsedToolNames.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {parsedToolNames.map((toolName) => (
                <span
                  key={`default-tool-${toolName}`}
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
            <p className="text-muted mt-1 text-xs">
              Add command-backed tools that agents can call by ID when enabled.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={addCustomTool}>
            <Plus className="h-4 w-4" />
            Add custom tool
          </Button>
        </div>

        {toolsConfig.custom.length === 0 ? (
          <p className="text-muted rounded-md border border-dashed px-3 py-2 text-sm">
            No custom tools configured.
          </p>
        ) : (
          <div className="space-y-3">
            {toolsConfig.custom.map((tool, index) => {
              const fieldErrors = customToolValidation[index];
              const argsInputValue = (tool.args ?? []).join(" ");
              const linksInputValue = (tool.provenance?.links ?? []).join(", ");

              return (
                <div
                  key={`${index}-${tool.id}`}
                  className="border-border-medium bg-background space-y-3 rounded-md border p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-foreground text-sm font-medium">
                        {tool.label.trim() || `Custom tool ${index + 1}`}
                      </p>
                      <p className="text-muted mt-0.5 text-xs">
                        ID: <code>{tool.id.trim() || "(not set)"}</code>
                      </p>
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
                      <Button variant="ghost" size="icon" onClick={() => removeCustomTool(index)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div>
                      <FieldLabel required>Tool ID</FieldLabel>
                      <Input
                        value={tool.id}
                        onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                          updateCustomTool(index, (prev) => ({ ...prev, id: event.target.value }))
                        }
                        placeholder="weather_lookup"
                        aria-invalid={fieldErrors.id !== null}
                      />
                      <p className="text-muted mt-1 text-xs">Used in prompts and tool routing.</p>
                      <FieldError message={fieldErrors.id} />
                    </div>

                    <div>
                      <FieldLabel required>Label</FieldLabel>
                      <Input
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
                    <FieldLabel required>Command</FieldLabel>
                    <Input
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
                    <FieldLabel>Args (space-separated)</FieldLabel>
                    <Input
                      value={argsInputValue}
                      onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                        updateCustomTool(index, (prev) => ({
                          ...prev,
                          args: parseSpaceSeparatedValues(event.target.value),
                        }))
                      }
                      placeholder="server.py --stdio"
                    />
                    <p className="text-muted mt-1 text-xs">
                      Enter command arguments in execution order, separated by spaces.
                    </p>
                  </div>

                  <div>
                    <FieldLabel>Instructions</FieldLabel>
                    <textarea
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
                      <FieldLabel>Provenance package</FieldLabel>
                      <Input
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
                      <FieldLabel>Provenance links (comma-separated)</FieldLabel>
                      <Input
                        value={linksInputValue}
                        onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                          updateCustomTool(index, (prev) => ({
                            ...prev,
                            provenance: {
                              ...(prev.provenance ?? {}),
                              links: parseCommaSeparatedValues(event.target.value),
                            },
                          }))
                        }
                        placeholder="https://github.com/acme/weather-tool"
                      />
                      {fieldErrors.provenanceLinks ? (
                        <p className="text-warning mt-1 text-xs">{fieldErrors.provenanceLinks}</p>
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

      <div className="flex items-center gap-2">
        <Button
          onClick={() => void save()}
          disabled={loading || saving || hasBlockingValidationError}
        >
          {saving ? "Saving…" : "Save tools settings"}
        </Button>
        <Button variant="outline" onClick={() => void load()} disabled={loading || saving}>
          Reset
        </Button>
        {hasBlockingValidationError ? (
          <p className="text-error text-xs">Resolve validation issues to save.</p>
        ) : null}
      </div>
    </div>
  );
}
