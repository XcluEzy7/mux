import React, { useEffect, useState, useCallback, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { useTheme, THEME_OPTIONS, type ThemePreference } from "@/browser/contexts/ThemeContext";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { Input } from "@/browser/components/Input/Input";
import { Switch } from "@/browser/components/Switch/Switch";
import { Button } from "@/browser/components/Button/Button";
import { CopyButton } from "@/browser/components/CopyButton/CopyButton";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useAPI } from "@/browser/contexts/API";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { generateTailscaleSshSnippet } from "@/browser/utils/tailscaleSshSnippet";
import type { TailscaleSshConfig, TailscaleInfo } from "@/common/orpc/schemas/api";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import {
  EDITOR_CONFIG_KEY,
  DEFAULT_EDITOR_CONFIG,
  TERMINAL_FONT_CONFIG_KEY,
  DEFAULT_TERMINAL_FONT_CONFIG,
  LAUNCH_BEHAVIOR_KEY,
  type EditorConfig,
  type EditorType,
  type LaunchBehavior,
  type TerminalFontConfig,
} from "@/common/constants/storage";
import {
  appendTerminalIconFallback,
  getPrimaryFontFamily,
  isFontFamilyAvailableInBrowser,
  isGenericFontFamily,
} from "@/browser/terminal/terminalFontFamily";
import {
  DEFAULT_CODER_ARCHIVE_BEHAVIOR,
  isCoderWorkspaceArchiveBehavior,
  type CoderWorkspaceArchiveBehavior,
} from "@/common/config/coderArchiveBehavior";
import {
  DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
  isWorktreeArchiveBehavior,
  type WorktreeArchiveBehavior,
} from "@/common/config/worktreeArchiveBehavior";

// Guard against corrupted/old persisted settings (e.g. from a downgraded build).
const ALLOWED_EDITOR_TYPES: ReadonlySet<EditorType> = new Set([
  "vscode",
  "cursor",
  "zed",
  "custom",
]);

function normalizeEditorConfig(value: unknown): EditorConfig {
  if (!value || typeof value !== "object") {
    return DEFAULT_EDITOR_CONFIG;
  }

  const record = value as { editor?: unknown; customCommand?: unknown };
  const editor =
    typeof record.editor === "string" && ALLOWED_EDITOR_TYPES.has(record.editor as EditorType)
      ? (record.editor as EditorType)
      : DEFAULT_EDITOR_CONFIG.editor;

  const customCommand =
    typeof record.customCommand === "string" && record.customCommand.trim()
      ? record.customCommand
      : undefined;

  return { editor, customCommand };
}

function getTerminalFontAvailabilityWarning(config: TerminalFontConfig): string | undefined {
  if (typeof document === "undefined") {
    return undefined;
  }

  const primary = getPrimaryFontFamily(config.fontFamily);
  if (!primary) {
    return undefined;
  }

  const normalizedPrimary = primary.trim();
  if (!normalizedPrimary) {
    return undefined;
  }

  // Geist Mono is bundled via @font-face. Treat it as always available so we don't show a
  // false-negative warning before the webfont finishes loading.
  if (normalizedPrimary.toLowerCase() === "geist mono") {
    return undefined;
  }

  if (isGenericFontFamily(normalizedPrimary)) {
    return undefined;
  }

  const primaryAvailable = isFontFamilyAvailableInBrowser(normalizedPrimary, config.fontSize);
  if (!primaryAvailable) {
    if (normalizedPrimary.endsWith("Nerd Font") && !normalizedPrimary.endsWith("Nerd Font Mono")) {
      const monoCandidate = `${normalizedPrimary} Mono`;
      if (isFontFamilyAvailableInBrowser(monoCandidate, config.fontSize)) {
        return `Font "${normalizedPrimary}" not found. Try "${monoCandidate}".`;
      }
    }

    return `Font "${normalizedPrimary}" not found in this browser.`;
  }

  return undefined;
}

function normalizeTerminalFontConfig(value: unknown): TerminalFontConfig {
  if (!value || typeof value !== "object") {
    return DEFAULT_TERMINAL_FONT_CONFIG;
  }

  const record = value as { fontFamily?: unknown; fontSize?: unknown };

  const fontFamily =
    typeof record.fontFamily === "string" && record.fontFamily.trim()
      ? record.fontFamily
      : DEFAULT_TERMINAL_FONT_CONFIG.fontFamily;

  const fontSizeNumber = Number(record.fontSize);
  const fontSize =
    Number.isFinite(fontSizeNumber) && fontSizeNumber > 0
      ? fontSizeNumber
      : DEFAULT_TERMINAL_FONT_CONFIG.fontSize;

  return { fontFamily, fontSize };
}

const EDITOR_OPTIONS: Array<{ value: EditorType; label: string }> = [
  { value: "vscode", label: "VS Code" },
  { value: "cursor", label: "Cursor" },
  { value: "zed", label: "Zed" },
  { value: "custom", label: "Custom" },
];

// Keep the legacy "dashboard" storage value for backwards compatibility even
// though the dedicated landing page has been removed. It now means "open the
// recent project page".
const LAUNCH_BEHAVIOR_OPTIONS = [
  { value: "dashboard", label: "Recent project" },
  { value: "new-chat", label: "New chat on recent project" },
  { value: "last-workspace", label: "Last visited workspace" },
] as const;
const ARCHIVE_BEHAVIOR_OPTIONS = [
  { value: "keep", label: "Keep running" },
  { value: "stop", label: "Stop workspace" },
  { value: "delete", label: "Delete workspace" },
] as const;
const WORKTREE_ARCHIVE_BEHAVIOR_OPTIONS: Array<{
  value: WorktreeArchiveBehavior;
  label: string;
}> = [
  { value: "keep", label: "Keep checkout" },
  { value: "delete", label: "Delete checkout" },
  { value: "snapshot", label: "Snapshot and delete" },
];

// Browser mode: window.api is not set (only exists in Electron via preload)
const isBrowserMode = typeof window !== "undefined" && !window.api;

function normalizeTailscaleUsername(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed == null || trimmed.length === 0) {
    return undefined;
  }
  return trimmed;
}

export function GeneralSection() {
  const { themePreference, setTheme } = useTheme();
  const { api } = useAPI();
  const [launchBehavior, setLaunchBehavior] = usePersistedState<LaunchBehavior>(
    LAUNCH_BEHAVIOR_KEY,
    "dashboard"
  );
  const [rawTerminalFontConfig, setTerminalFontConfig] = usePersistedState<TerminalFontConfig>(
    TERMINAL_FONT_CONFIG_KEY,
    DEFAULT_TERMINAL_FONT_CONFIG
  );
  const terminalFontConfig = normalizeTerminalFontConfig(rawTerminalFontConfig);
  const terminalFontWarning = getTerminalFontAvailabilityWarning(terminalFontConfig);

  const terminalFontPreviewFamily = appendTerminalIconFallback(terminalFontConfig.fontFamily);
  const terminalFontPreviewText = [
    String.fromCodePoint(0xf024b), // md-folder
    String.fromCodePoint(0xf0214), // md-file
    String.fromCodePoint(0xf02a2), // md-git
    String.fromCodePoint(0xea85), // cod-terminal
    String.fromCodePoint(0xe725), // dev-git_branch
    String.fromCodePoint(0xf135), // fa-rocket
  ].join(" ");

  const [rawEditorConfig, setEditorConfig] = usePersistedState<EditorConfig>(
    EDITOR_CONFIG_KEY,
    DEFAULT_EDITOR_CONFIG
  );
  const editorConfig = normalizeEditorConfig(rawEditorConfig);
  const [sshHost, setSshHost] = useState<string>("");
  const [sshHostLoaded, setSshHostLoaded] = useState(false);
  // Tailscale SSH state (browser mode + experiment gate)
  const tailscaleSshExperimentEnabled = useExperimentValue(EXPERIMENT_IDS.TAILSCALE_SSH);
  const [tailscaleSshConfig, setTailscaleSshConfig] = useState<TailscaleSshConfig | null>(null);
  const [tailscaleSshLoaded, setTailscaleSshLoaded] = useState(false);
  const [tailscaleInfo, setTailscaleInfo] = useState<TailscaleInfo | null>(null);
  const [detecting, setDetecting] = useState(false);
  const tailscaleSshConfigRef = useRef<TailscaleSshConfig | null>(null);
  const tailscaleSshWriteChainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    tailscaleSshConfigRef.current = tailscaleSshConfig;
  }, [tailscaleSshConfig]);

  const persistTailscaleSsh = useCallback(
    (next: TailscaleSshConfig | null) => {
      tailscaleSshConfigRef.current = next;
      setTailscaleSshConfig(next);
      if (next) {
        tailscaleSshWriteChainRef.current = tailscaleSshWriteChainRef.current
          .catch(() => {
            // Best-effort: previous write failed, continue chain.
          })
          .then(() => api?.server.setTailscaleSsh({ config: next }))
          .catch(() => {
            // Best-effort persistence — UI state is the source of truth.
          });
      }
    },
    [api]
  );
  const [defaultProjectDir, setDefaultProjectDir] = useState("");
  const [cloneDirLoaded, setCloneDirLoaded] = useState(false);
  // Track whether the initial load succeeded to prevent saving empty string
  // (which would clear the config) when the initial fetch failed.
  const [cloneDirLoadedOk, setCloneDirLoadedOk] = useState(false);

  // Backend config: default to the safest archive behavior until config finishes loading.
  const [archiveBehavior, setArchiveBehavior] = useState<CoderWorkspaceArchiveBehavior>(
    DEFAULT_CODER_ARCHIVE_BEHAVIOR
  );
  const [worktreeArchiveBehavior, setWorktreeArchiveBehavior] = useState<WorktreeArchiveBehavior>(
    DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR
  );
  const [archiveSettingsLoaded, setArchiveSettingsLoaded] = useState(false);
  const [llmDebugLogs, setLlmDebugLogs] = useState(false);
  const archiveBehaviorLoadNonceRef = useRef(0);
  const archiveBehaviorRef = useRef<CoderWorkspaceArchiveBehavior>(DEFAULT_CODER_ARCHIVE_BEHAVIOR);
  const worktreeArchiveBehaviorRef = useRef<WorktreeArchiveBehavior>(
    DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR
  );

  const llmDebugLogsLoadNonceRef = useRef(0);

  // updateCoderPrefs writes config.json on the backend. Serialize (and coalesce) updates so rapid
  // selections can't race and persist a stale value via out-of-order writes.
  const archiveBehaviorUpdateChainRef = useRef<Promise<void>>(Promise.resolve());
  const llmDebugLogsUpdateChainRef = useRef<Promise<void>>(Promise.resolve());
  const archiveBehaviorPendingUpdateRef = useRef<CoderWorkspaceArchiveBehavior | undefined>(
    undefined
  );
  const worktreeArchiveBehaviorPendingUpdateRef = useRef<WorktreeArchiveBehavior | undefined>(
    undefined
  );

  useEffect(() => {
    if (!api) {
      return;
    }

    setArchiveSettingsLoaded(false);
    const archiveBehaviorNonce = ++archiveBehaviorLoadNonceRef.current;
    const llmDebugLogsNonce = ++llmDebugLogsLoadNonceRef.current;

    void api.config
      .getConfig()
      .then((cfg) => {
        // If the user changed the setting while this request was in flight, keep the UI selection.
        if (archiveBehaviorNonce === archiveBehaviorLoadNonceRef.current) {
          const nextArchiveBehavior = isCoderWorkspaceArchiveBehavior(
            cfg.coderWorkspaceArchiveBehavior
          )
            ? cfg.coderWorkspaceArchiveBehavior
            : DEFAULT_CODER_ARCHIVE_BEHAVIOR;
          setArchiveBehavior(nextArchiveBehavior);
          archiveBehaviorRef.current = nextArchiveBehavior;

          const nextWorktreeArchiveBehavior = isWorktreeArchiveBehavior(cfg.worktreeArchiveBehavior)
            ? cfg.worktreeArchiveBehavior
            : DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR;
          setWorktreeArchiveBehavior(nextWorktreeArchiveBehavior);
          worktreeArchiveBehaviorRef.current = nextWorktreeArchiveBehavior;
          setArchiveSettingsLoaded(true);
        }

        // Use an independent nonce so debug-log toggles do not discard archive-setting updates.
        if (llmDebugLogsNonce === llmDebugLogsLoadNonceRef.current) {
          setLlmDebugLogs(cfg.llmDebugLogs === true);
        }
      })
      .catch(() => {
        if (archiveBehaviorNonce === archiveBehaviorLoadNonceRef.current) {
          // Fall back to the safe defaults already in state so the controls can recover after a
          // config read failure and the next user change can persist a fresh value.
          setArchiveSettingsLoaded(true);
        }
      });
  }, [api]);

  const queueArchiveBehaviorUpdate = useCallback(() => {
    if (!api?.config?.updateCoderPrefs || !archiveSettingsLoaded) {
      return;
    }

    archiveBehaviorUpdateChainRef.current = archiveBehaviorUpdateChainRef.current
      .then(async () => {
        // Drain pending refs so changes that happen while updateCoderPrefs is in-flight always
        // schedule another serialized write with the latest combined preferences.
        for (;;) {
          const pendingArchiveBehavior = archiveBehaviorPendingUpdateRef.current;
          const pendingWorktreeArchiveBehavior = worktreeArchiveBehaviorPendingUpdateRef.current;
          if (
            pendingArchiveBehavior === undefined &&
            pendingWorktreeArchiveBehavior === undefined
          ) {
            return;
          }

          // Clear before awaiting so rapid changes coalesce into a new pending value.
          archiveBehaviorPendingUpdateRef.current = undefined;
          worktreeArchiveBehaviorPendingUpdateRef.current = undefined;

          try {
            await api.config.updateCoderPrefs({
              coderWorkspaceArchiveBehavior: pendingArchiveBehavior ?? archiveBehaviorRef.current,
              worktreeArchiveBehavior:
                pendingWorktreeArchiveBehavior ?? worktreeArchiveBehaviorRef.current,
            });
          } catch {
            // Best-effort only. Swallow errors so the queue doesn't get stuck.
          }
        }
      })
      .catch(() => {
        // Best-effort only.
      });
  }, [api, archiveSettingsLoaded]);

  const handleArchiveBehaviorChange = useCallback(
    (behavior: CoderWorkspaceArchiveBehavior) => {
      if (!archiveSettingsLoaded || !api?.config?.updateCoderPrefs) {
        return;
      }

      // Invalidate any in-flight initial load so it doesn't overwrite the user's selection.
      archiveBehaviorLoadNonceRef.current++;
      setArchiveBehavior(behavior);
      archiveBehaviorRef.current = behavior;

      archiveBehaviorPendingUpdateRef.current = behavior;
      queueArchiveBehaviorUpdate();
    },
    [api, archiveSettingsLoaded, queueArchiveBehaviorUpdate]
  );

  const handleWorktreeArchiveBehaviorChange = useCallback(
    (behavior: WorktreeArchiveBehavior) => {
      if (!archiveSettingsLoaded || !api?.config?.updateCoderPrefs) {
        return;
      }

      // Invalidate any in-flight archive config load so it does not overwrite the user's choice.
      archiveBehaviorLoadNonceRef.current++;
      setWorktreeArchiveBehavior(behavior);
      worktreeArchiveBehaviorRef.current = behavior;

      worktreeArchiveBehaviorPendingUpdateRef.current = behavior;
      queueArchiveBehaviorUpdate();
    },
    [api, archiveSettingsLoaded, queueArchiveBehaviorUpdate]
  );

  const handleLlmDebugLogsChange = (checked: boolean) => {
    // Invalidate any in-flight debug-log load so it doesn't overwrite the user's selection.
    llmDebugLogsLoadNonceRef.current++;
    setLlmDebugLogs(checked);
    window.dispatchEvent(
      createCustomEvent(CUSTOM_EVENTS.LLM_DEBUG_LOGS_CHANGED, {
        enabled: checked,
      })
    );

    if (!api?.config?.updateLlmDebugLogs) {
      return;
    }

    // Serialize writes so rapid toggles always persist the last user choice.
    llmDebugLogsUpdateChainRef.current = llmDebugLogsUpdateChainRef.current
      .catch(() => {
        // Best-effort only.
      })
      .then(() => api.config.updateLlmDebugLogs({ enabled: checked }))
      .then(() => {
        // Coerce the chain back to Promise<void>.
      })
      .catch(() => {
        // Best-effort persistence.
      });
  };

  // Load SSH host from server on mount (browser mode only)
  useEffect(() => {
    if (isBrowserMode && api) {
      void api.server.getSshHost().then((host) => {
        setSshHost(host ?? "");
        setSshHostLoaded(true);
      });
    }
  }, [api]);

  // Load Tailscale SSH config from server on mount (browser mode + experiment only)
  useEffect(() => {
    if (!isBrowserMode || !tailscaleSshExperimentEnabled || !api) {
      return;
    }
    setTailscaleSshLoaded(false);
    void api.server
      .getTailscaleSsh()
      .then((config) => {
        setTailscaleSshConfig(
          config
            ? {
                ...config,
                username: normalizeTailscaleUsername(config.username),
              }
            : null
        );
      })
      .finally(() => {
        setTailscaleSshLoaded(true);
      });
  }, [api, tailscaleSshExperimentEnabled]);

  const handleTailscaleSshToggle = useCallback(
    (enabled: boolean) => {
      // Build a minimal config when enabling for the first time.
      // Default proxyCommand=true (ProxyCommand mode) to match the schema default.
      const next: TailscaleSshConfig = {
        ...(tailscaleSshConfig ?? { sshHost: undefined, username: undefined, proxyCommand: true }),
        enabled,
      };
      persistTailscaleSsh(next);
    },
    [tailscaleSshConfig, persistTailscaleSsh]
  );

  const handleTailscaleSshHostChange = useCallback(
    (value: string) => {
      if (!tailscaleSshConfig) {
        return;
      }
      // Trim to prevent whitespace-only hostnames from being persisted.
      const normalizedHost = value.trim();
      const next: TailscaleSshConfig = {
        ...tailscaleSshConfig,
        sshHost: normalizedHost || undefined,
      };
      persistTailscaleSsh(next);
    },
    [tailscaleSshConfig, persistTailscaleSsh]
  );

  const handleTailscaleSshUsernameChange = useCallback(
    (value: string) => {
      if (!tailscaleSshConfig) {
        return;
      }
      const next: TailscaleSshConfig = {
        ...tailscaleSshConfig,
        username: normalizeTailscaleUsername(value),
      };
      persistTailscaleSsh(next);
    },
    [tailscaleSshConfig, persistTailscaleSsh]
  );

  const handleTailscaleProxyCommandChange = useCallback(
    (proxyCommand: boolean) => {
      if (!tailscaleSshConfig) {
        return;
      }
      const next: TailscaleSshConfig = { ...tailscaleSshConfig, proxyCommand };
      persistTailscaleSsh(next);
    },
    [tailscaleSshConfig, persistTailscaleSsh]
  );

  const handleDetectTailscale = useCallback(
    async (force = false) => {
      if (!api) {
        return;
      }
      setDetecting(true);
      try {
        const info = await api.server.detectTailscale({ force });
        setTailscaleInfo(info);
        // Auto-fill sshHost from detected hostname/IP if not already set.
        // Read from ref to avoid stale closure after await.
        const currentConfig = tailscaleSshConfigRef.current;
        if (currentConfig && !currentConfig.sshHost && (info.hostname ?? info.ip)) {
          const autoHost = info.hostname ?? info.ip ?? "";
          const next: TailscaleSshConfig = { ...currentConfig, sshHost: autoHost };
          persistTailscaleSsh(next);
        }
      } finally {
        setDetecting(false);
      }
    },
    [api, persistTailscaleSsh]
  );

  useEffect(() => {
    if (!api) {
      return;
    }

    void api.projects
      .getDefaultProjectDir()
      .then((dir) => {
        setDefaultProjectDir(dir);
        setCloneDirLoaded(true);
        setCloneDirLoadedOk(true);
      })
      .catch(() => {
        // Best-effort only. Keep the input editable if load fails,
        // but don't mark as successfully loaded to prevent clearing config on blur.
        setCloneDirLoaded(true);
      });
  }, [api]);

  const handleEditorChange = (editor: EditorType) => {
    setEditorConfig((prev) => ({ ...normalizeEditorConfig(prev), editor }));
  };

  const handleTerminalFontFamilyChange = (fontFamily: string) => {
    setTerminalFontConfig((prev) => ({ ...normalizeTerminalFontConfig(prev), fontFamily }));
  };

  const handleTerminalFontSizeChange = (rawValue: string) => {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return;
    }

    setTerminalFontConfig((prev) => ({ ...normalizeTerminalFontConfig(prev), fontSize: parsed }));
  };
  const handleCustomCommandChange = (customCommand: string) => {
    setEditorConfig((prev) => ({ ...normalizeEditorConfig(prev), customCommand }));
  };

  const handleSshHostChange = useCallback(
    (value: string) => {
      setSshHost(value);
      // Save to server (debounced effect would be better, but keeping it simple)
      void api?.server.setSshHost({ sshHost: value || null });
    },
    [api]
  );

  const handleCloneDirBlur = useCallback(() => {
    // Only persist once the initial load has completed (success or failure).
    // After a failed load, allow saves only if the user has actively typed
    // a non-empty value, so we never silently clear a configured directory.
    if (!cloneDirLoaded || !api) {
      return;
    }

    const trimmedProjectDir = defaultProjectDir.trim();
    if (!cloneDirLoadedOk && !trimmedProjectDir) {
      return;
    }

    void api.projects
      .setDefaultProjectDir({ path: defaultProjectDir })
      .then(() => {
        // A successful save means subsequent clears are safe, even if the
        // initial getDefaultProjectDir() request failed earlier in this session.
        setCloneDirLoadedOk(true);
      })
      .catch(() => {
        // Best-effort save: keep current UI state on failure.
      });
  }, [api, cloneDirLoaded, cloneDirLoadedOk, defaultProjectDir]);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-foreground mb-4 text-sm font-medium">Appearance</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Theme</div>
              <div className="text-muted text-xs">Choose your preferred theme</div>
            </div>
            <Select
              value={themePreference}
              onValueChange={(value) => setTheme(value as ThemePreference)}
            >
              <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto cursor-pointer rounded-md border px-3 text-sm transition-colors">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THEME_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Launch behavior</div>
              <div className="text-muted text-xs">What to show when Mux starts</div>
            </div>
            <Select
              value={launchBehavior}
              onValueChange={(value) => setLaunchBehavior(value as LaunchBehavior)}
            >
              <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto cursor-pointer rounded-md border px-3 text-sm transition-colors">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LAUNCH_BEHAVIOR_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Terminal Font</div>
              {terminalFontWarning ? (
                <div className="text-warning text-xs">{terminalFontWarning}</div>
              ) : null}
              <div className="text-muted text-xs">Set this to a monospace font you like.</div>
              <div className="text-muted text-xs">
                Preview:{" "}
                <span className="text-foreground" style={{ fontFamily: terminalFontPreviewFamily }}>
                  {terminalFontPreviewText}
                </span>
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              <Input
                value={terminalFontConfig.fontFamily}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  handleTerminalFontFamilyChange(e.target.value)
                }
                placeholder={DEFAULT_TERMINAL_FONT_CONFIG.fontFamily}
                className="border-border-medium bg-background-secondary h-9 w-80"
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Terminal Font Size</div>
              <div className="text-muted text-xs">Font size for the integrated terminal</div>
            </div>
            <Input
              type="number"
              value={terminalFontConfig.fontSize}
              min={6}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                handleTerminalFontSizeChange(e.target.value)
              }
              className="border-border-medium bg-background-secondary h-9 w-28"
            />
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-foreground mb-4 text-sm font-medium">Workspace insights</h3>
        <div className="divide-border-light divide-y">
          <div className="flex items-center justify-between py-3">
            <div className="flex-1 pr-4">
              <div className="text-foreground text-sm">API Debug Logs</div>
              <div className="text-muted mt-0.5 text-xs">
                Record the full input and output of every AI API call
              </div>
            </div>
            <Switch
              checked={llmDebugLogs}
              onCheckedChange={handleLlmDebugLogsChange}
              aria-label="Toggle API Debug Logs"
            />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <div className="text-foreground text-sm">Editor</div>
          <div className="text-muted text-xs">Editor to open files in</div>
        </div>
        <Select value={editorConfig.editor} onValueChange={handleEditorChange}>
          <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto cursor-pointer rounded-md border px-3 text-sm transition-colors">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EDITOR_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {editorConfig.editor === "custom" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-foreground text-sm">Custom Command</div>
              <div className="text-muted text-xs">Command to run (path will be appended)</div>
            </div>
            <Input
              value={editorConfig.customCommand ?? ""}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                handleCustomCommandChange(e.target.value)
              }
              placeholder="e.g., nvim"
              className="border-border-medium bg-background-secondary h-9 w-40"
            />
          </div>
          {isBrowserMode && (
            <div className="text-warning text-xs">
              Custom editors are not supported in browser mode. Use VS Code or Cursor instead.
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        <div className="flex-1">
          <div className="text-foreground text-sm">Coder workspace on archive</div>
          <div className="text-muted text-xs">
            Action to take on dedicated Coder workspaces when archiving a chat. Delete is permanent.
          </div>
        </div>
        <Select
          value={archiveBehavior}
          onValueChange={(value) =>
            handleArchiveBehaviorChange(value as CoderWorkspaceArchiveBehavior)
          }
          disabled={!api?.config?.updateCoderPrefs || !archiveSettingsLoaded}
        >
          <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto cursor-pointer rounded-md border px-3 text-sm transition-colors">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ARCHIVE_BEHAVIOR_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="flex-1">
          <div className="text-foreground text-sm">Worktree archive behavior</div>
          <div className="text-muted text-xs">
            Control whether archived mux-managed worktrees stay on disk, are deleted, or are
            snapshotted so they can be restored on unarchive.
          </div>
        </div>
        <Select
          value={worktreeArchiveBehavior}
          onValueChange={(value) =>
            handleWorktreeArchiveBehaviorChange(value as WorktreeArchiveBehavior)
          }
          disabled={!api?.config?.updateCoderPrefs || !archiveSettingsLoaded}
        >
          <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto cursor-pointer rounded-md border px-3 text-sm transition-colors">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WORKTREE_ARCHIVE_BEHAVIOR_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isBrowserMode && sshHostLoaded && (
        <div className="flex items-center justify-between">
          <div>
            <div className="text-foreground text-sm">SSH Host</div>
            <div className="text-muted text-xs">
              SSH hostname for &apos;Open in Editor&apos; deep links
            </div>
          </div>
          <Input
            value={sshHost}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              handleSshHostChange(e.target.value)
            }
            placeholder={window.location.hostname}
            className="border-border-medium bg-background-secondary h-9 w-40"
          />
        </div>
      )}

      {isBrowserMode && tailscaleSshExperimentEnabled && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-foreground text-sm">Tailscale SSH</div>
              <div className="text-muted text-xs">
                Use Tailscale hostname for &apos;Open in Editor&apos; deep links
              </div>
            </div>
            <Switch
              checked={tailscaleSshConfig?.enabled ?? false}
              disabled={!tailscaleSshLoaded}
              onCheckedChange={handleTailscaleSshToggle}
              aria-label="Enable Tailscale SSH"
            />
          </div>

          {tailscaleSshConfig?.enabled && (
            <div className="border-border-light ml-2 space-y-3 border-l pl-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <div className="text-foreground text-sm">Tailscale Host</div>
                  <div className="text-muted text-xs">
                    Tailscale hostname or IP for SSH connections
                  </div>
                </div>
                <Input
                  value={tailscaleSshConfig.sshHost ?? ""}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    handleTailscaleSshHostChange(e.target.value)
                  }
                  placeholder="hostname.tailnet.ts.net"
                  className="border-border-medium bg-background-secondary h-9 w-48"
                />
              </div>

              <details className="rounded-md border border-transparent">
                <summary className="text-foreground cursor-pointer text-sm">
                  Advanced connection settings
                </summary>
                <div className="mt-3 flex items-center justify-between gap-4">
                  <div className="flex-1">
                    <div className="text-foreground text-sm">SSH username</div>
                    <div className="text-muted text-xs">
                      Used in the SSH config on your local device. Leave blank to use your OS
                      username.
                    </div>
                  </div>
                  <Input
                    value={tailscaleSshConfig.username ?? ""}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      handleTailscaleSshUsernameChange(e.target.value)
                    }
                    placeholder="your-username"
                    className="border-border-medium bg-background-secondary h-9 w-48"
                  />
                </div>
              </details>

              <div>
                <div className="text-foreground mb-2 text-sm">Connection Mode</div>
                <div className="space-y-1">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="radio"
                      name="tailscale-connection-mode"
                      checked={!tailscaleSshConfig.proxyCommand}
                      onChange={() => handleTailscaleProxyCommandChange(false)}
                      className="accent-primary"
                    />
                    <span className="text-foreground text-sm">Tailscale SSH server</span>
                    <span className="text-muted text-xs">(requires Tailscale SSH enabled)</span>
                  </label>
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="radio"
                      name="tailscale-connection-mode"
                      checked={tailscaleSshConfig.proxyCommand}
                      onChange={() => handleTailscaleProxyCommandChange(true)}
                      className="accent-primary"
                    />
                    <span className="text-foreground text-sm">ProxyCommand</span>
                    <span className="text-muted text-xs">
                      (tailscale nc, works without Tailscale SSH)
                    </span>
                  </label>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  onClick={() => {
                    void handleDetectTailscale(true);
                  }}
                  disabled={detecting}
                  size="sm"
                  variant="outline"
                >
                  {detecting ? "Detecting..." : "Detect Tailscale"}
                </Button>
                {tailscaleInfo != null && (
                  <span className="text-muted text-xs">
                    {tailscaleInfo.available
                      ? `${tailscaleInfo.hostname ?? tailscaleInfo.ip ?? "connected"}${tailscaleInfo.tailnet ? ` (${tailscaleInfo.tailnet})` : ""}`
                      : "Tailscale not detected"}
                  </span>
                )}
              </div>

              {tailscaleInfo != null &&
                tailscaleInfo.available &&
                !tailscaleInfo.sshEnabled &&
                !tailscaleSshConfig.proxyCommand && (
                  <div className="bg-warning/10 border-warning/30 rounded-md border p-3">
                    <div className="text-warning mb-2 flex items-center gap-1.5 text-xs font-medium">
                      <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                      Tailscale SSH is not enabled on this machine
                    </div>
                    <div className="text-muted mb-2 text-xs">
                      Use ProxyCommand mode, or add this to your local{" "}
                      <code className="bg-background-secondary rounded px-1">~/.ssh/config</code>:
                    </div>
                    <div className="bg-background-secondary relative rounded p-2">
                      <pre className="text-foreground overflow-x-auto text-xs">
                        {generateTailscaleSshSnippet(tailscaleInfo, {
                          username: tailscaleSshConfig.username,
                        })}
                      </pre>
                      <div className="absolute top-1.5 right-1.5">
                        <CopyButton
                          text={generateTailscaleSshSnippet(tailscaleInfo, {
                            username: tailscaleSshConfig.username,
                          })}
                        />
                      </div>
                    </div>
                  </div>
                )}
            </div>
          )}
        </div>
      )}

      <div>
        <h3 className="text-foreground mb-4 text-sm font-medium">Projects</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Default project directory</div>
              <div className="text-muted text-xs">
                Parent folder for new projects and cloned repositories
              </div>
            </div>
            <Input
              value={defaultProjectDir}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setDefaultProjectDir(e.target.value)
              }
              onBlur={handleCloneDirBlur}
              placeholder="~/.mux/projects"
              disabled={!cloneDirLoaded}
              className="border-border-medium bg-background-secondary h-9 w-80"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
