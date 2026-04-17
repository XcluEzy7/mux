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

# Start dev server (backend :3000 + frontend :5173 with HMR)
dev:
    make dev-server

# List all recipes
list:
    just --list
