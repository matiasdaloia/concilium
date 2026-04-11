import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverContext, formatDiscoveredContext } from './context-discovery.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'concilium-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('discoverContext', () => {
  it('discovers AGENTS.md in repo root', () => {
    writeFileSync(join(tempDir, 'AGENTS.md'), '# Review rules\n- Use TypeScript strict mode');
    const ctx = discoverContext(tempDir);
    expect(ctx.conventions).toHaveLength(1);
    expect(ctx.conventions[0].label).toBe('Agent Instructions (AGENTS.md)');
    expect(ctx.conventions[0].content).toContain('TypeScript strict mode');
  });

  it('discovers .concilium/review.md with higher priority than AGENTS.md', () => {
    mkdirSync(join(tempDir, '.concilium'), { recursive: true });
    writeFileSync(join(tempDir, '.concilium', 'review.md'), '# Our review standards');
    writeFileSync(join(tempDir, 'AGENTS.md'), '# Agent rules');

    const ctx = discoverContext(tempDir);
    expect(ctx.conventions).toHaveLength(2);
    expect(ctx.conventions[0].label).toBe('Concilium Review Guidelines');
    expect(ctx.conventions[1].label).toBe('Agent Instructions (AGENTS.md)');
    expect(ctx.hasReviewGuidelines).toBe(true);
  });

  it('discovers MCP servers from .concilium/mcp.json', () => {
    mkdirSync(join(tempDir, '.concilium'), { recursive: true });
    writeFileSync(
      join(tempDir, '.concilium', 'mcp.json'),
      JSON.stringify({
        servers: {
          snyk: { url: 'https://snyk-mcp.example.com' },
          semgrep: { command: 'semgrep-mcp', args: ['--stdio'] },
        },
      }),
    );

    const ctx = discoverContext(tempDir);
    expect(ctx.mcpServers).toHaveLength(2);
    expect(ctx.mcpServers[0].name).toBe('snyk');
    expect(ctx.mcpServers[1].name).toBe('semgrep');
  });

  it('detects project stack from marker files', () => {
    writeFileSync(join(tempDir, 'package.json'), '{}');
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');

    const ctx = discoverContext(tempDir);
    expect(ctx.detectedStack).toContain('Node.js / JavaScript / TypeScript');
    expect(ctx.detectedStack).toContain('TypeScript');
  });

  it('returns empty context for bare directory', () => {
    const ctx = discoverContext(tempDir);
    expect(ctx.conventions).toHaveLength(0);
    expect(ctx.mcpServers).toHaveLength(0);
    expect(ctx.detectedStack).toHaveLength(0);
    expect(ctx.hasReviewGuidelines).toBe(false);
  });

  it('truncates files over 10K chars', () => {
    writeFileSync(join(tempDir, 'AGENTS.md'), 'x'.repeat(15_000));
    const ctx = discoverContext(tempDir);
    expect(ctx.conventions[0].content).toContain('[Truncated');
    expect(ctx.conventions[0].content.length).toBeLessThan(11_000);
  });

  it('skips empty files', () => {
    writeFileSync(join(tempDir, 'AGENTS.md'), '');
    const ctx = discoverContext(tempDir);
    expect(ctx.conventions).toHaveLength(0);
  });
});

describe('formatDiscoveredContext', () => {
  it('formats stack and conventions into injectable string', () => {
    const ctx = {
      conventions: [
        { path: 'AGENTS.md', label: 'Agent Instructions', content: '# Rules\n- Be strict' },
      ],
      mcpServers: [{ name: 'snyk', url: 'https://snyk.example.com' }],
      detectedStack: ['TypeScript', 'Node.js / JavaScript / TypeScript'],
      hasReviewGuidelines: true,
    };

    const formatted = formatDiscoveredContext(ctx);
    expect(formatted).toContain('## Project Stack');
    expect(formatted).toContain('TypeScript');
    expect(formatted).toContain('## Agent Instructions');
    expect(formatted).toContain('Be strict');
    expect(formatted).toContain('## Available MCP Tools');
    expect(formatted).toContain('snyk');
  });
});
