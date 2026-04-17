# Build the web frontend (Vite → dist/)
web:
    make build-renderer

# Full build (renderer + main + preload + icons + static)
build:
    make build

# Build all distributable packages
dist: build
    bun x electron-builder --publish never

# Build Linux AppImage
appimage: build
    bun x electron-builder --linux --publish never

# Build Windows NSIS installer
win: build
    bun x electron-builder --win --publish never

# Build macOS distributable (parallel x64 + arm64 when not code-signing)
mac: build
    #!/usr/bin/env bash
    if [ -n "$CSC_LINK" ]; then \
        bun x electron-builder --mac --x64 --arm64 --publish never; \
    else \
        bun x electron-builder --mac --x64 --publish never & pid1=$!; \
        bun x electron-builder --mac --arm64 --publish never & pid2=$!; \
        wait $pid1; \
        wait $pid2; \
    fi

# Full rebuild + replace system CLI with repo-built binary
#
# Usage: DRYRUN=true just cli
#
# This recipe:
# 1. Builds the project (make build)
# 2. Finds existing 'mux' on PATH
# 3. Removes it (with sudo if needed for system paths)
# 4. Creates symlink to dist/cli/index.js at the same location
# 5. Verifies the new CLI works
#
# With dry-run=true: Shows what would be done without making changes
#
# To undo: just unlink-cli
cli:
    #!/usr/bin/env bash
    set -euo pipefail 2>/dev/null || set -euo  # fallback for bash 3.2 (macOS)

    # Get DRYRUN from just args, default to false
    DRYRUN="${DRYRUN:-false}"

    if [ "$DRYRUN" = "true" ]; then
        echo "DRY RUN: Would run 'just build' before installing the CLI"
    else
        just build
    fi

    CLI_SRC="$(pwd)/dist/cli/index.js"

    if [ ! -f "$CLI_SRC" ]; then
        echo "Error: Built CLI not found at $CLI_SRC" >&2
        exit 1
    fi

    if [ "$DRYRUN" = "true" ]; then
        echo "DRY RUN: Would ensure $CLI_SRC is executable"
    else
        chmod +x "$CLI_SRC"
    fi

    EXISTING=$(which mux 2>/dev/null || true)

    if [ -n "$EXISTING" ]; then
        REAL=$(readlink -f "$EXISTING" 2>/dev/null || readlink "$EXISTING" 2>/dev/null || echo "$EXISTING")
        DEST="$EXISTING"
        if [ "$DRYRUN" = "true" ]; then
            echo "DRY RUN: Found existing mux at $DEST (→ $REAL)"
        else
            echo "Found existing mux at $DEST (→ $REAL)"
        fi

        # Use sudo for system paths
        if [ -w "$(dirname "$DEST")" ]; then
            RM="rm -f"
            LN="ln -sf"
        else
            if [ "$DRYRUN" = "true" ]; then
                echo "DRY RUN: System path detected — would use sudo"
            else
                echo "System path detected — using sudo"
            fi
            RM="sudo rm -f"
            LN="sudo ln -sf"
        fi

        if [ "$DRYRUN" = "true" ]; then
            echo "DRY RUN: Would backup and remove existing binary/symlink"
        else
            # Backup existing binary/symlink before removing
            BACKUP="${DEST}.bak-$$"
            if [ -L "$DEST" ]; then
                cp -P "$DEST" "$BACKUP" 2>/dev/null || true
                $RM "$DEST"
                echo "Removed symlink $DEST (backup: $BACKUP)"
            elif [ -f "$DEST" ]; then
                cp "$DEST" "$BACKUP" 2>/dev/null || true
                $RM "$DEST"
                echo "Removed binary $DEST (backup: $BACKUP)"
            fi
        fi
    else
        # Fallback: install to ~/.local/bin
        mkdir -p "$HOME/.local/bin"
        DEST="$HOME/.local/bin/mux"
        RM="rm -f"
        LN="ln -sf"
        BACKUP=""
        if [ "$DRYRUN" = "true" ]; then
            echo "DRY RUN: No existing mux found — would install to $DEST"
        else
            echo "No existing mux found — installing to $DEST"
        fi
    fi

    if [ "$DRYRUN" = "true" ]; then
        echo "DRY RUN: Would create symlink $DEST → $CLI_SRC"
        echo "DRY RUN: Would verify CLI works with 'mux --version'"
        echo "DRY RUN: CLI installation completed successfully (no changes made)"
    else
        # Create symlink to repo-built CLI
        $LN "$CLI_SRC" "$DEST"
        echo "Linked $DEST → $CLI_SRC"

        # Verify the new CLI works
        hash -r 2>/dev/null || true
        export PATH="$(dirname "$DEST"):$PATH"
        if ! "$DEST" --version; then
            echo "Error: New CLI failed to run" >&2
            # Attempt rollback
            $RM "$DEST" 2>/dev/null || true
            if [ -n "$BACKUP" ] && [ -e "$BACKUP" ]; then
                echo "Attempting rollback..."
                mv "$BACKUP" "$DEST" 2>/dev/null && echo "Restored backup"
            fi
            exit 1
        fi

        # Clean up backup on success
        [ -n "$BACKUP" ] && [ -e "$BACKUP" ] && rm -f "$BACKUP" 2>/dev/null

        echo "CLI installed successfully"
    fi

# Remove the dev CLI symlink created by `just cli`
#
# Only removes symlinks that point to a path ending in "dist/cli/index.js"
# (exact suffix match to avoid false positives like "dist/cli/index.js.bak")
unlink-cli:
    #!/usr/bin/env bash
    EXISTING=$(which mux 2>/dev/null || true)
    if [ -n "$EXISTING" ] && [ -L "$EXISTING" ]; then
        TARGET=$(readlink "$EXISTING")
        # Check for exact suffix match to avoid false positives
        case "$TARGET" in
            */dist/cli/index.js|dist/cli/index.js)
                if [ -w "$(dirname "$EXISTING")" ]; then
                    rm -f "$EXISTING"
                else
                    sudo rm -f "$EXISTING"
                fi
                echo "Removed dev CLI symlink $EXISTING"
                ;;
            *)
                echo "Refusing to remove $EXISTING — it points to $TARGET, not a dev build" >&2
                exit 1
                ;;
        esac
    else
        echo "No dev CLI symlink found on PATH"
    fi

# Start the hot-reload dev server stack in the background.
#
# Override DEV_SERVER_CMD/DEV_SERVER_PID_FILE/DEV_SERVER_LOG_FILE for tests or custom workflows.
dev:
    just start

# Alias for the background dev server lifecycle entrypoint.
start:
    just dev-server-start

# Stop the background dev server stack.
stop:
    just dev-server-stop

# Restart the background dev server stack.
restart:
    just dev-server-restart

# Show background dev server status.
status:
    just dev-server-status

# Print recent background dev server logs. Set FOLLOW=true to tail -f.
logs:
    just dev-server-logs

# Explicit foreground escape hatch for cases where interactive output is preferred.
dev-server-fg:
    make dev-server

dev-server-start:
    #!/usr/bin/env bash
    set -euo pipefail 2>/dev/null || set -euo

    PID_FILE="${DEV_SERVER_PID_FILE:-build/just/dev-server.pid}"
    LOG_FILE="${DEV_SERVER_LOG_FILE:-build/just/dev-server.log}"
    CMD="${DEV_SERVER_CMD:-make dev-server}"
    STARTUP_WAIT_SECS="${DEV_SERVER_STARTUP_WAIT_SECS:-1}"

    mkdir -p "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"

    if [ -f "$PID_FILE" ]; then
        EXISTING_PID="$(tr -d '[:space:]' < "$PID_FILE" 2>/dev/null || true)"
        if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
            echo "Dev server already running (pid $EXISTING_PID)"
            echo "PID file: $PID_FILE"
            echo "Log file: $LOG_FILE"
            exit 0
        fi
        rm -f "$PID_FILE"
    fi

    printf '\n[%s] starting %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$CMD" >> "$LOG_FILE"

    if command -v setsid >/dev/null 2>&1; then
        setsid bash -lc "$CMD" >> "$LOG_FILE" 2>&1 < /dev/null &
    else
        nohup bash -lc "$CMD" >> "$LOG_FILE" 2>&1 < /dev/null &
    fi

    PID="$!"
    printf '%s\n' "$PID" > "$PID_FILE"
    sleep "$STARTUP_WAIT_SECS"

    if ! kill -0 "$PID" 2>/dev/null; then
        echo "Dev server failed to stay up" >&2
        echo "Recent log output:" >&2
        tail -n 120 "$LOG_FILE" >&2 || true
        rm -f "$PID_FILE"
        exit 1
    fi

    echo "Started dev server in background (pid $PID)"
    echo "PID file: $PID_FILE"
    echo "Log file: $LOG_FILE"

dev-server-stop:
    #!/usr/bin/env bash
    set -euo pipefail 2>/dev/null || set -euo

    PID_FILE="${DEV_SERVER_PID_FILE:-build/just/dev-server.pid}"

    if [ ! -f "$PID_FILE" ]; then
        echo "No dev server pid file found at $PID_FILE"
        exit 0
    fi

    PID="$(tr -d '[:space:]' < "$PID_FILE" 2>/dev/null || true)"
    if [ -z "$PID" ]; then
        rm -f "$PID_FILE"
        echo "Removed empty dev server pid file"
        exit 0
    fi

    if ! kill -0 "$PID" 2>/dev/null; then
        rm -f "$PID_FILE"
        echo "Removed stale dev server pid file for pid $PID"
        exit 0
    fi

    PGID="$(ps -o pgid= -p "$PID" 2>/dev/null | tr -d '[:space:]' || true)"
    if [ -n "$PGID" ]; then
        kill -TERM "-$PGID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true
    else
        kill -TERM "$PID" 2>/dev/null || true
    fi

    for _ in $(seq 1 50); do
        if ! kill -0 "$PID" 2>/dev/null; then
            rm -f "$PID_FILE"
            echo "Stopped dev server (pid $PID)"
            exit 0
        fi
        sleep 0.2
    done

    if [ -n "$PGID" ]; then
        kill -KILL "-$PGID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null || true
    else
        kill -KILL "$PID" 2>/dev/null || true
    fi

    rm -f "$PID_FILE"
    echo "Force-stopped dev server (pid $PID)"

dev-server-restart:
    just dev-server-stop
    just dev-server-start

dev-server-status:
    #!/usr/bin/env bash
    set -euo pipefail 2>/dev/null || set -euo

    PID_FILE="${DEV_SERVER_PID_FILE:-build/just/dev-server.pid}"
    LOG_FILE="${DEV_SERVER_LOG_FILE:-build/just/dev-server.log}"

    if [ ! -f "$PID_FILE" ]; then
        echo "Dev server is not running"
        echo "PID file: $PID_FILE"
        echo "Log file: $LOG_FILE"
        exit 0
    fi

    PID="$(tr -d '[:space:]' < "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        echo "Dev server is running (pid $PID)"
        echo "PID file: $PID_FILE"
        echo "Log file: $LOG_FILE"
    else
        echo "Dev server is not running (stale pid file at $PID_FILE)"
        echo "Log file: $LOG_FILE"
        exit 1
    fi

dev-server-logs:
    #!/usr/bin/env bash
    set -euo pipefail 2>/dev/null || set -euo

    LOG_FILE="${DEV_SERVER_LOG_FILE:-build/just/dev-server.log}"
    TAIL_LINES="${TAIL_LINES:-200}"
    FOLLOW="${FOLLOW:-false}"

    if [ ! -f "$LOG_FILE" ]; then
        echo "No dev server log found at $LOG_FILE"
        exit 0
    fi

    if [ "$FOLLOW" = "true" ]; then
        tail -n "$TAIL_LINES" -f "$LOG_FILE"
    else
        tail -n "$TAIL_LINES" "$LOG_FILE"
    fi

# List all recipes
list:
    just --list
