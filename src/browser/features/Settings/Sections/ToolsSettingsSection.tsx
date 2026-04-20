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
import type { CustomTool, ToolsConfig, ToolsDefaultMode } from "@/common/config/schemas";

const DEFAULT_TOOLS_CONFIG: ToolsConfig = {
  defaults: {
    mode: "allow_all_except",
    toolNames: [],
  },
  custom: [],
};

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

  const save = useCallback(async () => {
    if (!api?.config?.updateToolsConfig) {
      return;
    }

    const parsedToolNames = toolNamesInput
      .split(",")
      .map((toolName) => toolName.trim())
      .filter((toolName) => toolName.length > 0);

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
  }, [api, toolNamesInput, toolsConfig]);

  return (
    <div className="space-y-6">
      <p className="text-muted text-xs">
        Configure global tool defaults and custom tools stored in <code>~/.mux/config.json</code>.
        Custom tools run through MCP stdio plumbing.
      </p>

      {error && <p className="text-error text-sm">{error}</p>}

      <div className="space-y-3">
        <h3 className="text-foreground text-sm font-medium">Default policy</h3>
        <div className="flex items-center gap-3">
          <span className="text-muted text-sm">Mode</span>
          <Select
            value={toolsConfig.defaults.mode}
            onValueChange={(value) => updateMode(value as ToolsDefaultMode)}
          >
            <SelectTrigger className="w-60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="allow_all_except">Allow all except listed tools</SelectItem>
              <SelectItem value="deny_all_except">Deny all except listed tools</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-muted mb-1 block text-xs">Tool names (comma-separated)</label>
          <Input
            value={toolNamesInput}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
              setToolNamesInput(event.target.value)
            }
            placeholder="bash, file_edit_replace_string"
          />
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-foreground text-sm font-medium">Custom tools</h3>
          <Button variant="outline" size="sm" onClick={addCustomTool}>
            <Plus className="h-4 w-4" />
            Add custom tool
          </Button>
        </div>

        {toolsConfig.custom.length === 0 ? (
          <p className="text-muted text-sm">No custom tools configured.</p>
        ) : (
          toolsConfig.custom.map((tool, index) => (
            <div
              key={`${index}-${tool.id}`}
              className="border-border-medium space-y-2 rounded-md border p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-foreground text-sm font-medium">
                  {tool.label || `Custom tool ${index + 1}`}
                </span>
                <div className="flex items-center gap-2">
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

              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <Input
                  value={tool.id}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                    updateCustomTool(index, (prev) => ({ ...prev, id: event.target.value }))
                  }
                  placeholder="id"
                />
                <Input
                  value={tool.label}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                    updateCustomTool(index, (prev) => ({ ...prev, label: event.target.value }))
                  }
                  placeholder="label"
                />
              </div>

              <Input
                value={tool.command}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                  updateCustomTool(index, (prev) => ({ ...prev, command: event.target.value }))
                }
                placeholder="command"
              />

              <Input
                value={(tool.args ?? []).join(" ")}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                  updateCustomTool(index, (prev) => ({
                    ...prev,
                    args: event.target.value
                      .split(/\s+/)
                      .map((arg) => arg.trim())
                      .filter((arg) => arg.length > 0),
                  }))
                }
                placeholder="args (space-separated)"
              />

              <Input
                value={tool.instructions ?? ""}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                  updateCustomTool(index, (prev) => ({
                    ...prev,
                    instructions: event.target.value || undefined,
                  }))
                }
                placeholder="instructions"
              />

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
                placeholder="provenance package"
              />

              <Input
                value={(tool.provenance?.links ?? []).join(", ")}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                  updateCustomTool(index, (prev) => ({
                    ...prev,
                    provenance: {
                      ...(prev.provenance ?? {}),
                      links: event.target.value
                        .split(",")
                        .map((link) => link.trim())
                        .filter((link) => link.length > 0),
                    },
                  }))
                }
                placeholder="provenance links (comma-separated)"
              />
            </div>
          ))
        )}
      </div>

      <div>
        <Button onClick={() => void save()} disabled={loading || saving}>
          {saving ? "Saving…" : "Save tools settings"}
        </Button>
      </div>
    </div>
  );
}
