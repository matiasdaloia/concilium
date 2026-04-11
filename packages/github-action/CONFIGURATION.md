# Concilium Configuration

Concilium auto-discovers project conventions and review guidelines from your repository. No configuration is required — but you can customize everything.

## How It Works

When `concilium verify` runs, it scans your repo for convention files **before** the agents start reviewing. Discovered content is injected into the review prompt so agents follow your team's standards.

```
Your repo
├── .concilium/
│   ├── review.md          ← Your review guidelines (highest priority)
│   ├── focus.md           ← Always-review patterns and areas
│   └── mcp.json           ← MCP server connections (Snyk, Semgrep, etc.)
├── AGENTS.md              ← Cross-tool agent instructions (industry standard)
├── CLAUDE.md              ← Claude-specific instructions
├── .github/
│   └── copilot-instructions.md
└── ... your code
```

All of these are optional. Concilium reads whatever exists and ignores what doesn't.

## `.concilium/review.md` — Review Guidelines

This is the primary way to customize what agents look for. Write it like you'd write review guidelines for a new team member.

**Example:**

```markdown
# Code Review Standards

## Security
- All user input MUST be validated with zod schemas before reaching business logic
- SQL queries MUST use parameterized queries, never string concatenation
- API endpoints MUST check authentication via the `requireAuth` middleware
- Secrets MUST NOT appear in code — use environment variables

## Architecture
- Follow the hexagonal architecture: domain logic in `src/domain/`, adapters in `src/adapters/`
- New API endpoints MUST have a corresponding OpenAPI schema in `docs/api/`
- Database access MUST go through repository interfaces, never direct queries

## Testing
- All bug fixes MUST include a regression test
- New functions with branching logic MUST have unit tests covering each branch
- Integration tests MUST use the test database, not mocks

## Style
- Use `Result<T, E>` pattern for operations that can fail, not thrown exceptions
- Prefer early returns over nested if/else
- Maximum function length: 40 lines
```

## `.concilium/focus.md` — Focus Areas

Tell agents what to pay extra attention to. Useful for areas with known tech debt or high-risk modules.

**Example:**

```markdown
# Focus Areas

## High-Risk Modules
- `src/payments/` — Any change here needs extra scrutiny for PCI compliance
- `src/auth/` — Authentication bypass is a critical severity finding
- `infrastructure/` — Terraform changes can take down production

## Known Tech Debt
- The `UserService` class is a god object — flag any changes that make it bigger
- `src/legacy/` uses the old ORM — flag if new code still uses it instead of the new repository pattern

## Recent Incidents
- 2026-03-15: Race condition in order processing when two requests hit the same cart. Watch for similar patterns.
```

## `.concilium/mcp.json` — MCP Server Connections

Connect external analysis tools via the [Model Context Protocol](https://modelcontextprotocol.io). Agents can use these tools during review for deeper analysis.

**Example:**

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

**Supported server types:**
- **Remote** (`url`): Connect to an HTTP MCP server
- **Local** (`command` + `args`): Spawn a local MCP server process

Environment variable references (`${VAR_NAME}`) are resolved from the runtime environment, making it safe to commit this file — secrets stay in CI environment variables.

## Other Convention Files (Auto-Discovered)

Concilium also reads these standard convention files if they exist:

| File | Standard | Used By |
|------|----------|---------|
| `AGENTS.md` | [Agentic AI Foundation](https://agents.md/) | Sourcegraph, OpenAI, Google, Cursor, Factory |
| `CLAUDE.md` | Anthropic | Claude Code |
| `.github/copilot-instructions.md` | GitHub | GitHub Copilot |
| `.cursor/rules/review.md` | Cursor | Cursor AI |
| `.cursorrules` | Cursor (legacy) | Cursor AI |
| `GEMINI.md` | Google | Gemini |

**Priority order:** `.concilium/review.md` > `AGENTS.md` > `CLAUDE.md` > others.

If you already have `AGENTS.md` with your coding standards, Concilium uses it automatically. No duplication needed.

## Stack Detection

Concilium detects your project stack from marker files (`package.json`, `go.mod`, `Cargo.toml`, etc.) and includes it in the review context. This helps agents understand framework-specific patterns and conventions.

## GitHub Action Example

With a `.concilium/review.md` in your repo, the action is just:

```yaml
- uses: matiasdaloia/concilium-action@v1
  with:
    openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
```

The agents will automatically follow your review guidelines. No `custom-instructions` input needed.
