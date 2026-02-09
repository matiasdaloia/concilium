import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { AgentId, CommandSpec } from './types';

export function resolveOpenCodeBinary(): string {
  const homeBin = join(homedir(), '.opencode', 'bin', 'opencode');
  if (existsSync(homeBin)) return homeBin;
  return 'opencode';
}

export function wrapPromptForResearch(prompt: string): string {
  return `You are participating in a multi-agent council. Research and answer the following request thoroughly.

INSTRUCTIONS:
- Use all available tools (web search, file reading) to gather information
- Do NOT write, modify, create, or delete any files
- Do NOT execute code or run commands that change state
- You MAY read files and search the web to inform your answer
- Provide a comprehensive, well-researched answer
- Be thorough and cite sources when possible
- Return your final plan/answer as markdown text directly in your response (do not write to a file)

USER REQUEST:
${prompt}`;
}

export function buildCommand(input: {
  agentId: AgentId;
  cwd: string;
  prompt: string;
  model?: string | null;
}): CommandSpec {
  switch (input.agentId) {
    case 'codex':
      return buildCodexCommand(input);
    case 'claude':
      return buildClaudeCommand(input);
    case 'opencode':
      return buildOpenCodeCommand(input);
    default:
      throw new Error(`Unsupported agent: ${String(input.agentId)}`);
  }
}

function buildCodexCommand(input: { cwd: string; prompt: string; model?: string | null }): CommandSpec {
  const args = ['exec', '--json', '--sandbox', 'read-only'];
  args.push('--cd', input.cwd);
  if (input.model?.trim()) {
    args.push('--model', input.model.trim());
  }
  args.push(wrapPromptForResearch(input.prompt));
  return { command: 'codex', args, env: {} };
}

function buildClaudeCommand(input: { prompt: string; model?: string | null }): CommandSpec {
  const args = [
    '--verbose',
    '--print',
    '--output-format', 'stream-json',
    '--permission-mode', 'plan',
    '--include-partial-messages',
    '--no-session-persistence',
    '--disallowedTools', 'Write', 'Edit', 'NotebookEdit'
  ];
  if (input.model?.trim()) {
    args.push('--model', input.model.trim());
  }
  args.push(wrapPromptForResearch(input.prompt));
  return { command: 'claude', args, env: {} };
}

function buildOpenCodeCommand(input: { prompt: string; model?: string | null }): CommandSpec {
  const args = ['run', '--format', 'json', '--thinking'];
  if (input.model?.trim()) {
    args.push('--model', input.model.trim());
  }
  args.push(wrapPromptForResearch(input.prompt));
  return {
    command: resolveOpenCodeBinary(),
    args,
    env: {
      OPENCODE_EXPERIMENTAL_PLAN_MODE: 'true',
      OPENCODE_PERMISSION: JSON.stringify({
        edit: 'deny',
        write: 'deny',
        bash: {
          '*': 'deny',
          'ls *': 'allow',
          'cat *': 'allow',
          'find *': 'allow',
          'grep *': 'allow',
          'pwd': 'allow',
          'head *': 'allow',
          'tail *': 'allow',
          'echo *': 'allow'
        }
      })
    }
  };
}

export function mergedEnv(commandEnv?: Record<string, string>): Record<string, string> {
  return { ...process.env as Record<string, string>, ...commandEnv };
}
