# Build the web frontend (Vite → dist/)
web:
    make build-renderer

# Full build (renderer + main + preload + icons + static)
build:
    make build

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
        wait $pid1 && wait $pid2; \
    fi

# Full rebuild + replace system CLI with repo-built binary
cli: build
    #!/usr/bin/env bash
    set -euo pipefail

    CLI_SRC="$(pwd)/dist/cli/index.js"

    if [ ! -f "$CLI_SRC" ]; then
        echo "Error: Built CLI not found at $CLI_SRC" >&2
        exit 1
    fi

    EXISTING=$(which mux 2>/dev/null || true)

    if [ -n "$EXISTING" ]; then
        REAL=$(readlink -f "$EXISTING" 2>/dev/null || readlink "$EXISTING" 2>/dev/null || echo "$EXISTING")
        DEST="$EXISTING"
        echo "Found existing mux at $DEST (→ $REAL)"

        # Use sudo for system paths
        if [ -w "$(dirname "$DEST")" ]; then
            RM="rm -f"
            LN="ln -sf"
        else
            echo "System path detected — using sudo"
            RM="sudo rm -f"
            LN="sudo ln -sf"
        fi

        # Remove existing binary/symlink
        if [ -L "$DEST" ]; then
            $RM "$DEST"
            echo "Removed symlink $DEST"
        elif [ -f "$DEST" ]; then
            $RM "$DEST"
            echo "Removed binary $DEST"
        fi
    else
        # Fallback: install to ~/.local/bin
        mkdir -p "$HOME/.local/bin"
        DEST="$HOME/.local/bin/mux"
        RM="rm -f"
        LN="ln -sf"
        echo "No existing mux found — installing to $DEST"
    fi

    # Create symlink to repo-built CLI
    $LN "$CLI_SRC" "$DEST"
    echo "Linked $DEST → $CLI_SRC"

    # Verify
    hash -r 2>/dev/null || true
    export PATH="$(dirname "$DEST"):$PATH"
    mux --version
    echo "CLI installed successfully"

# Clean all build artifacts
clean:
    make clean

# Remove the dev CLI symlink created by `just cli`
unlink-cli:
    #!/usr/bin/env bash
    EXISTING=$(which mux 2>/dev/null || true)
    if [ -n "$EXISTING" ] && [ -L "$EXISTING" ]; then
        TARGET=$(readlink "$EXISTING")
        if [[ "$TARGET" == *"dist/cli/index.js"* ]]; then
            if [ -w "$(dirname "$EXISTING")" ]; then
                rm -f "$EXISTING"
            else
                sudo rm -f "$EXISTING"
            fi
            echo "Removed dev CLI symlink $EXISTING"
        else
            echo "Refusing to remove $EXISTING — it points to $TARGET, not a dev build" >&2
            exit 1
        fi
    else
        echo "No dev CLI symlink found on PATH"

# Start dev server (backend :3000 + frontend :5173 with HMR)
dev:
    make dev-server

# List all recipes
list:
    just --list
