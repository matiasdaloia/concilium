import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('context-discovery');

/**
 * Convention files to discover, in priority order.
 * Higher priority files appear first in the injected context.
 */
const CONVENTION_FILES = [
  // Concilium-specific (highest priority)
  { path: '.concilium/review.md', label: 'Concilium Review Guidelines' },
  { path: '.concilium/focus.md', label: 'Concilium Focus Areas' },

  // Cross-tool standards
  { path: 'AGENTS.md', label: 'Agent Instructions (AGENTS.md)' },

  // Tool-specific (still useful context)
  { path: 'CLAUDE.md', label: 'Claude Instructions (CLAUDE.md)' },
  { path: '.github/copilot-instructions.md', label: 'Copilot Instructions' },
  { path: '.cursor/rules/review.md', label: 'Cursor Review Rules' },
  { path: '.cursorrules', label: 'Cursor Rules (legacy)' },
  { path: 'GEMINI.md', label: 'Gemini Instructions (GEMINI.md)' },
];

/**
 * Stack detection files — used to infer project type for smarter reviews.
 */
const STACK_MARKERS: Array<{ file: string; stack: string }> = [
  { file: 'package.json', stack: 'Node.js / JavaScript / TypeScript' },
  { file: 'tsconfig.json', stack: 'TypeScript' },
  { file: 'go.mod', stack: 'Go' },
  { file: 'Cargo.toml', stack: 'Rust' },
  { file: 'pyproject.toml', stack: 'Python' },
  { file: 'requirements.txt', stack: 'Python' },
  { file: 'Gemfile', stack: 'Ruby' },
  { file: 'pom.xml', stack: 'Java (Maven)' },
  { file: 'build.gradle', stack: 'Java/Kotlin (Gradle)' },
  { file: 'Program.cs', stack: '.NET / C#' },
  { file: 'mix.exs', stack: 'Elixir' },
  { file: 'composer.json', stack: 'PHP' },
];

export interface DiscoveredConvention {
  path: string;
  label: string;
  content: string;
}

export interface McpServerConfig {
  name: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface DiscoveredContext {
  conventions: DiscoveredConvention[];
  mcpServers: McpServerConfig[];
  detectedStack: string[];
  hasReviewGuidelines: boolean;
}

/**
 * Scans a repository directory for convention files, MCP server configs,
 * and project stack markers. Returns everything Concilium needs to build
 * an enriched review prompt.
 */
export function discoverContext(cwd: string): DiscoveredContext {
  const conventions: DiscoveredConvention[] = [];
  const detectedStack: string[] = [];

  // Discover convention files
  for (const { path: relPath, label } of CONVENTION_FILES) {
    const fullPath = join(cwd, relPath);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, 'utf-8').trim();
        if (content.length > 0) {
          // Cap at 10K chars to avoid blowing up the prompt
          const truncated = content.length > 10_000
            ? content.slice(0, 10_000) + '\n\n[Truncated — file exceeds 10,000 characters]'
            : content;
          conventions.push({ path: relPath, label, content: truncated });
          logger.debug(`Discovered: ${relPath} (${content.length} chars)`);
        }
      } catch {
        logger.debug(`Failed to read: ${relPath}`);
      }
    }
  }

  // Discover MCP servers
  const mcpServers = discoverMcpServers(cwd);

  // Detect project stack
  for (const { file, stack } of STACK_MARKERS) {
    if (existsSync(join(cwd, file))) {
      if (!detectedStack.includes(stack)) {
        detectedStack.push(stack);
      }
    }
  }

  const hasReviewGuidelines = conventions.some(
    (c) => c.path === '.concilium/review.md' || c.path === 'AGENTS.md',
  );

  logger.info(
    `Context discovery: ${conventions.length} convention files, ${mcpServers.length} MCP servers, stack: [${detectedStack.join(', ')}]`,
  );

  return { conventions, mcpServers, detectedStack, hasReviewGuidelines };
}

function discoverMcpServers(cwd: string): McpServerConfig[] {
  const servers: McpServerConfig[] = [];

  // Check .concilium/mcp.json
  const conciliumMcpPath = join(cwd, '.concilium', 'mcp.json');
  if (existsSync(conciliumMcpPath)) {
    try {
      const raw = readFileSync(conciliumMcpPath, 'utf-8');
      const config = JSON.parse(raw) as {
        servers?: McpServerConfig[] | Record<string, McpServerConfig>;
      };

      if (Array.isArray(config.servers)) {
        servers.push(...config.servers);
      } else if (config.servers && typeof config.servers === 'object') {
        for (const [name, server] of Object.entries(config.servers)) {
          servers.push({ ...server, name });
        }
      }
      logger.debug(`Discovered ${servers.length} MCP servers from .concilium/mcp.json`);
    } catch (err) {
      logger.debug(`Failed to parse .concilium/mcp.json: ${(err as Error).message}`);
    }
  }

  return servers;
}

/**
 * Formats discovered context into a string that can be injected into the
 * agent's review prompt.
 */
export function formatDiscoveredContext(ctx: DiscoveredContext): string {
  const sections: string[] = [];

  if (ctx.detectedStack.length > 0) {
    sections.push(`## Project Stack\n${ctx.detectedStack.join(', ')}`);
  }

  for (const convention of ctx.conventions) {
    sections.push(`## ${convention.label}\n_Source: ${convention.path}_\n\n${convention.content}`);
  }

  if (ctx.mcpServers.length > 0) {
    const names = ctx.mcpServers.map((s) => s.name).join(', ');
    sections.push(`## Available MCP Tools\nThe following MCP servers are configured: ${names}. Use them if relevant to the review.`);
  }

  return sections.join('\n\n---\n\n');
}
