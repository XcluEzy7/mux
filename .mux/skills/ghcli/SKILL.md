---
name: ghcli
description: Guidelines for using the GitHub CLI (gh) for GitHub Actions and GitHub Repo Management. Use when interacting with GitHub PRs, issues, releases, actions, or repository settings via the gh CLI.
---

# GitHub CLI (gh) Guidelines

## Repo Default

In this repo, set `gh repo set-default` to the writable origin repo (`XcluEzy7/mux`), not the upstream (`coder/mux`). Set it once:

```bash
gh repo set-default XcluEzy7/mux
```

Verify with:

```bash
gh repo set-default --view
```

## Remotes Convention

- `origin` — this repo's writable main remote (`XcluEzy7/mux`); push branches here and target PRs at `origin/main`
- `upstream` — the upstream project (`coder/mux`); read-only for fetching latest changes

```bash
git remote add upstream https://github.com/coder/mux.git
```

When running `gh` commands without `--repo`, it uses the default repo. Keep it set to `XcluEzy7/mux`, not upstream.

## PR Management

### List / View PRs

```bash
gh pr list --state open --limit 10
gh pr view <number>
gh pr diff <number>
```

### Create PRs

```bash
gh pr create --base main --title "feat: description" --body "Summary of changes"
```

This keeps the PR targeted at `origin/main` in this repo.

### PR Checks & Reviews

```bash
gh pr checks <number>
gh pr view <number> --json reviews,comments
```

### PR Comments

For multi-line comments, use `--body-file -` with a heredoc:

```bash
gh pr comment <number> --body-file - <<'EOF'
Your multi-line
comment here
EOF
```

### Merge Status

Check mergeability fields:

| Field              | Value         | Meaning             |
| ------------------ | ------------- | ------------------- |
| `mergeable`        | `MERGEABLE`   | Clean, no conflicts |
| `mergeable`        | `CONFLICTING` | Needs resolution    |
| `mergeStateStatus` | `CLEAN`       | Ready to merge      |
| `mergeStateStatus` | `BLOCKED`     | Waiting for CI      |

## Issue Management

```bash
gh issue list --state open --limit 20
gh issue create --title "Bug: description" --body "Details"
gh issue view <number>
gh issue close <number>
```

## GitHub Actions

### List / View Workflows

```bash
gh run list --limit 10
gh run view <run-id>
gh run view <run-id> --log
```

### Re-run Failed Checks

```bash
gh run rerun <run-id>
```

### Watch a Run

```bash
gh run watch <run-id>
```

## Releases

```bash
gh release list --limit 10
gh release create v1.0.0 --title "v1.0.0" --notes "Release notes"
```

## API Calls

For endpoints not covered by built-in commands, use the API directly:

```bash
gh api repos/<owner>/<repo>/pulls/<number>/comments
gh api repos/<owner>/<repo>/issues/<number>/comments
```

Parse JSON output with `jq`:

```bash
gh api repos/<owner>/<repo>/pulls/<number>/reviews | jq -r '.[] | "\(.user.login): \(.state)"'
```

## Common Pitfalls

- **Wrong repo default**: `gh` defaults to the repo detected from `git remote`. If `gh` resolves to upstream, explicitly set `gh repo set-default XcluEzy7/mux`.
- **JSON overflow in terminals**: `gh pr view --json` can produce very long lines. Pipe through `jq` or use `--jq` flag.
- **GraphQL deprecation warnings**: Some API fields (e.g., `projectCards`) are deprecated. Filter them with `--jq` or `jq` to keep output clean.
- **Never push to upstream**: All pushes go to `origin` (`XcluEzy7/mux`). PRs should target `origin/main`; use upstream only for fetching.
