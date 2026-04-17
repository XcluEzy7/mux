---
name: create-custom-agent
description: Generate a custom Mux agent definition with correct YAML frontmatter, tool policy, and inheritance
advertise: true
---

# Create Custom Agent

Generate a Mux agent definition file (`.md`) with valid YAML frontmatter, tool policy, and optional inheritance.

## Prerequisites

Before creating an agent, confirm with the user:

1. **Name**: The agent ID (lowercase, becomes the filename: `<name>.md`)
2. **Purpose**: What the agent should do (becomes the description and body)
3. **Base**: Which agent to inherit from (usually `exec`, `plan`, or `explore`)
4. **Tool policy**: What tools to add, remove, or require
5. **Scope**: Project (`.mux/agents/`) or global (`~/.mux/agents/`)

## Step 1: Choose the base agent

| Base | Use When |
|------|---------|
| `exec` | Full implementation agent — edit files, run commands, create tasks |
| `plan` | Structured planning agent — proposes plans, restricted edits |
| `explore` | Read-only investigation — no file edits, only search and read |
| `compact` | History compaction — summarizes conversations |
| Custom | Inherit from another custom agent |

## Step 2: Define the tool policy

Tool policy uses regex patterns on tool names:

- **`add`**: Enable tools matching patterns (e.g., `[".*"]` for all, `["file_read", "bash"]` for specific)
- **`remove`**: Disable tools matching patterns (e.g., `["file_edit_.*"]` for no editing)
- **`require`**: Force-enable a single tool by exact name (e.g., `["switch_agent"]`)

Inheritance composes: base → child. `remove` always overrides `add`. `require` uses last-wins across layers.

### Common tool policy patterns

| Pattern | Effect |
|---------|--------|
| Read-only reviewer | `remove: [file_edit_.*, task, task_.*, propose_plan, ask_user_question]` |
| With sub-agent spawning | `require: [switch_agent]` |
| No git modifications | `remove: [bash]` then `add: [bash]` with scoping (use model/tool scoped sections) |
| Bash-only investigator | `add: [file_read, bash, grep_search]` |

### Runtime restrictions for sub-agents

These cannot be overridden by agent definitions:
- `ask_user_question` and `switch_agent` are hard-denied for sub-agents
- `task_*` tools are denied when nesting depth is exceeded
- Plan-like sub-agents must call `propose_plan`; others must call `agent_report`

## Step 3: Write the agent definition

Create the `.md` file with this structure:

```md
---
name: <Display Name>
description: <Short description for tooltips>
base: <exec|plan|explore|or custom agent ID>
ui:
  hidden: <true|false>       # Hide from agent selector
  routable: <true|false>     # Allow switch_agent to target this
  disabled: <true|false>     # Completely disable
  color: <CSS color>         # Badge color (inherited from base if not set)
prompt:
  append: <true|false>        # true = append body to base body (default), false = replace
tools:
  add: [<regex patterns>]     # Enable tools
  remove: [<regex patterns>]  # Disable tools (overrides add)
  require: [<exact tool name>] # Force-enable tool (last-wins across inheritance)
subagent:
  runnable: <true|false>      # Allow spawning via task tool
  append_prompt: |             # Extra instructions when spawned as sub-agent
    <additional prompt text>
  skip_init_hook: <true|false> # Skip .mux/init when spawned
ai:
  model: <model abbreviation or full ID>
  thinkingLevel: <low|medium|high>
---

<Agent system prompt body — becomes the agent's instructions>
```

### Required fields

- `name` (1–128 chars, must match filename case-insensitively)
- Valid YAML frontmatter between `---` delimiters

### Inheritance tips

- When a project-level agent has the same ID as a built-in (e.g., `exec.md` with `base: exec`), Mux skips the project scope during base resolution to avoid self-reference
- `prompt.append: true` (default) appends the body to the base's body; `false` replaces it
- `ui.color` inherits from base if not specified
- Tool policy composes base → child

### Scoped sections in agent body

Agent bodies support `Model:` and `Tool:` scoped headings:

```md
You are a general-purpose agent.

Model: sonnet
Be concise and direct.

Model: o3
Think step by step. Show your reasoning.

Tool: bash
Prefer structured CLI tools over manual parsing.

Tool: file_edit_file
Always show a diff before applying edits.
```

## Step 4: Place the file correctly

| Scope | Path | Effect |
|-------|------|--------|
| Project | `<project>/.mux/agents/<name>.md` | Overrides all, scoped to project |
| Global | `~/.mux/agents/<name>.md` | Available across all projects |
| Built-in | Embedded in Mux | Lowest priority, cannot be edited |

Project agents override global agents which override built-in agents.

## Step 5: Validate

After creating the agent, verify:

1. **File placement**: Confirmed in `.mux/agents/` (project) or `~/.mux/agents/` (global)
2. **YAML syntax**: Frontmatter between `---` delimiters parses as valid YAML
3. **Filename matches name**: `<name>.md` file, name field matches (case-insensitive)
4. **Base exists**: The `base` field refers to an existing agent ID
5. **Tool patterns are valid regex**: Patterns in `add`/`remove` must compile as `^<pattern>$`
6. **File size under 1MB**: Large files are rejected during discovery
7. **Sub-agent completion tool**: If `subagent.runnable: true`, the body should instruct the agent to call `propose_plan` (if it inherits from `plan`) or `agent_report` (otherwise) exactly once when done

## Anti-patterns to avoid

- **Don't use `disabled: true` on core agents** (`exec`, `plan`, `compact`, `mux`) — they're always enabled as fallbacks
- **Don't add broad `add: [".*"]` to sub-agents** — sub-agents already inherit their base's tool policy
- **Don't use `require` with regex patterns** — require only accepts exact tool names (literal identifiers)
- **Don't create circular inheritance chains** — Mux detects and stops at cycles with a warning
- **Don't put agent files in subdirectories** — discovery is non-recursive; only top-level `.md` files are found
- **Don't forget sub-agent completion** — every sub-agent must call either `propose_plan` or `agent_report` exactly once

## Examples

### Security Reviewer (read-only sub-agent)

```md
---
name: Security Audit
description: Security-focused code review with OWASP awareness
base: exec
tools:
  add:
    - ".*"
  remove:
    - file_edit_.*
    - propose_plan
    - ask_user_question
subagent:
  runnable: true
  append_prompt: |
    You are a security audit sub-agent. Focus exclusively on security concerns.
    Call agent_report exactly once when done with your findings.
---

You are a security auditor specializing in application security.

- Check for: injection flaws, broken auth, sensitive data exposure, security misconfiguration
- Reference OWASP Top 10 categories when applicable
- Rate each finding as Critical / High / Medium / Low
- Never modify code — only report findings
```

### Custom Compact Agent

```md
# ~/.mux/agents/compact.md
---
name: Compact
description: History compaction with project-aware context preservation
prompt:
  append: false
---

You are running a compaction/summarization pass. Write a concise summary.

- Preserve project-specific conventions, file paths, and architectural decisions
- Keep TODO items verbatim
- Summarize code changes as diffs, not full listings
- Preserve the current task context
```

### Triage Agent (switch_agent enabled)

```md
---
name: Triage
description: Route requests to specialists
base: exec
tools:
  add:
    - ".*"
  require:
    - switch_agent
---

You are a triage agent. Analyze requests and hand off to the appropriate specialist using switch_agent.
```
