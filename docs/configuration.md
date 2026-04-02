# Configuration

Concilium auto-discovers project conventions from your repository. Zero config required — but fully customizable.

## How Discovery Works

When `concilium verify` runs, it scans your repo root for convention files **before** agents start reviewing. Any discovered content is injected into the review prompt so agents follow your team's standards.

```
your-repo/
├── .concilium/           ← Concilium-specific config (optional)
│   ├── review.md         ← Your review guidelines (highest priority)
│   ├── focus.md          ← High-risk areas and known issues
│   └── mcp.json          ← MCP server connections
├── AGENTS.md             ← Cross-tool agent instructions
├── CLAUDE.md             ← Claude-specific instructions
├── .github/
│   └── copilot-instructions.md
└── ... your code
```

**Discovery priority order** (highest first):
1. `.concilium/review.md`
2. `.concilium/focus.md`
3. `AGENTS.md`
4. `CLAUDE.md`
5. `.github/copilot-instructions.md`
6. `.cursor/rules/review.md`
7. `.cursorrules`
8. `GEMINI.md`

If you already have an `AGENTS.md` with your coding standards, Concilium uses it automatically. No duplication needed.

## `.concilium/review.md` — Review Guidelines

The primary way to customize what agents look for. Write it like you'd write review instructions for a new team member.

```markdown
# Code Review Standards

## Security
- All user input MUST be validated with zod schemas before reaching business logic
- SQL queries MUST use parameterized queries, never string concatenation
- API endpoints MUST check authentication via the `requireAuth` middleware
- Secrets MUST NOT appear in code — use environment variables

## Architecture
- Follow hexagonal architecture: domain logic in `src/domain/`, adapters in `src/adapters/`
- New API endpoints MUST have a corresponding OpenAPI schema in `docs/api/`
- Database access MUST go through repository interfaces, never direct queries

## Testing
- All bug fixes MUST include a regression test
- New functions with branching logic MUST have unit tests covering each branch

## Style
- Use `Result<T, E>` pattern for fallible operations, not thrown exceptions
- Prefer early returns over nested if/else
- Maximum function length: 40 lines
```

## `.concilium/focus.md` — Focus Areas

Tell agents what deserves extra scrutiny. Useful for high-risk modules, known tech debt, or patterns from recent incidents.

```markdown
# Focus Areas

## High-Risk Modules
- `src/payments/` — PCI compliance required. Flag any logging of card data.
- `src/auth/` — Authentication bypass is critical severity.
- `infrastructure/` — Terraform changes can take down production.

## Known Tech Debt
- The `UserService` class is a god object — flag changes that make it bigger
- `src/legacy/` uses the old ORM — flag if new code uses it instead of the repository pattern

## Recent Incidents
- 2026-03-15: Race condition in order processing when two requests hit the same cart.
  Watch for similar patterns in any concurrent code paths.
```

## `.concilium/mcp.json` — MCP Server Connections

Connect external analysis tools via the [Model Context Protocol](https://modelcontextprotocol.io). Agents can call these tools during review for deeper static analysis, security scanning, and more.

```json
{
  "servers": {
    "snyk": {
      "url": "https://mcp.snyk.io",
      "env": {
        "SNYK_TOKEN": "${SNYK_TOKEN}"
      }
    },
    "semgrep": {
      "command": "semgrep-mcp",
      "args": ["--stdio"]
    },
    "sonarqube": {
      "url": "https://sonar.yourcompany.com/mcp",
      "env": {
        "SONAR_TOKEN": "${SONAR_TOKEN}"
      }
    }
  }
}
```

**Server types:**
- **Remote** (`url`): Connect to an HTTP MCP server
- **Local** (`command` + `args`): Spawn a local MCP server process

Environment variable references (`${VAR_NAME}`) are resolved at runtime. Safe to commit — secrets stay in CI environment variables.

**Popular MCP servers for code review:**

| Server | What It Does |
|--------|-------------|
| [Snyk](https://snyk.io) | SAST, SCA, container, IaC scanning (11 tools) |
| [Semgrep](https://semgrep.dev) | Static analysis, custom rules, bug/vulnerability detection |
| [SonarQube](https://www.sonarqube.org) | Code quality, security hotspots, tech debt tracking |
| [Trivy](https://trivy.dev) | Vulnerability scanning, SBOM, license detection |

## Stack Detection

Concilium automatically detects your project stack from marker files:

| File | Detected Stack |
|------|---------------|
| `package.json` | Node.js / JavaScript / TypeScript |
| `tsconfig.json` | TypeScript |
| `go.mod` | Go |
| `Cargo.toml` | Rust |
| `pyproject.toml` | Python |
| `pom.xml` | Java (Maven) |
| `build.gradle` | Java/Kotlin (Gradle) |
| `mix.exs` | Elixir |
| `composer.json` | PHP |

Stack info is included in the review prompt so agents understand framework-specific patterns.

## `AGENTS.md` — Cross-Tool Standard

[AGENTS.md](https://agents.md/) is an open standard (stewarded by the Linux Foundation's Agentic AI Foundation) for providing instructions to AI coding agents. Supported by Sourcegraph, OpenAI, Google, Cursor, and Factory.

If you already maintain an `AGENTS.md`, Concilium reads it automatically. No need to duplicate content in `.concilium/review.md` — but if both exist, `.concilium/review.md` takes priority.

## CLI Configuration

### API Key

```bash
# Store locally (persisted in ~/.config/concilium/preferences.json)
concilium config set api-key sk-or-v1-...

# Or use environment variable (preferred for CI)
export OPENROUTER_API_KEY=sk-or-v1-...
```

### Default Models

```bash
# Set default juror models
concilium config set jurors "openai/gpt-5.2,google/gemini-3-pro-preview"

# Set default chairman model
concilium config set chairman "google/gemini-3-pro-preview"
```

### View Configuration

```bash
concilium config show        # Display current config
concilium config path        # Print config file location
concilium config reset       # Reset to defaults
```

### Config File Location

Concilium follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html):

| Type | Location |
|------|----------|
| Config | `~/.config/concilium/` |
| Data (run history) | `~/.local/share/concilium/` |
| Cache | `~/.cache/concilium/` |
