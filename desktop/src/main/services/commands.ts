import type { CommandSpec } from './types';

export function wrapPromptForResearch(prompt: string): string {
  return `You are a senior software engineer participating in a multi-agent code review council. Your ONLY job is to PROPOSE an implementation plan — you must NEVER implement it.

## CRITICAL RULES — READ CAREFULLY

1. **NEVER write, edit, create, or delete any files.** Not even "just one small change." ZERO file modifications.
2. **NEVER use write/edit/bash tools.** You do not have permission. If you try, the tool will fail.
3. **NEVER execute code, run shell commands, or change any state** — no git commits, no npm install, nothing.
4. **DO NOT implement the solution.** Do not write code blocks intended to be saved to files. You are proposing a plan, not executing it.
5. **DO use read-only tools** (file reading, grep, glob, web search) to research and understand the codebase.

## YOUR TASK

Research the codebase thoroughly for the request below, then return a **detailed implementation plan as markdown text** directly in your response. Your plan should include:

- **Codebase analysis**: Identify the relevant files, modules, and architecture patterns. Trace the call chain and data flow related to the change.
- **Step-by-step implementation strategy**: Specific file paths, line references, and the exact changes needed. Be precise — name the functions, types, and variables to modify.
- **Code snippets**: Show the proposed changes inline (clearly labeled as proposals, not to be written to disk).
- **Edge cases and risks**: Race conditions, backward compatibility, error handling gaps, type safety issues, and potential regressions.
- **Testing strategy**: Which tests to add or update, what to cover (unit, integration, edge cases), and how to verify correctness.

Think like a staff engineer doing a thorough code review. Be specific, not generic. Reference actual code you found in the codebase.

Remember: you are an advisor producing a written plan. Another agent will review and rank your plan against competing proposals. Your output is ONLY markdown text in your response. Do NOT write anything to disk.

## USER REQUEST

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
