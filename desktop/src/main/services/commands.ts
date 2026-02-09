import type { CommandSpec } from './types';

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

/**
 * Build a CLI command spec.  Only Claude still uses the subprocess path;
 * OpenCode and Codex are handled exclusively via their respective SDKs.
 */
export function buildClaudeCommand(input: {
  prompt: string;
  model?: string | null;
}): CommandSpec {
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

export function mergedEnv(commandEnv?: Record<string, string>): Record<string, string> {
  return { ...process.env as Record<string, string>, ...commandEnv };
}
