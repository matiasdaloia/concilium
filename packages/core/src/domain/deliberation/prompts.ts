import type { Stage1Result, Stage2Result } from '../council/stage-results.js';

export function wrapPromptForResearch(prompt: string): string {
  return `You are a senior software engineer participating in a multi-agent code review council. Your ONLY job is to PROPOSE an implementation plan — you must NEVER implement it.

## CRITICAL RULES — READ CAREFULLY

1. **NEVER write, edit, create, or delete any files.** Not even "just one small change." ZERO file modifications.
2. **NEVER use write/edit/bash tools.** You do not have permission. If you try, the tool will fail.
3. **NEVER execute code, run shell commands, or change any state** — no git commits, no npm install, nothing.
4. **DO NOT implement the solution.** Do not write code blocks intended to be saved to files. You are proposing a plan, not executing it.
5. **NEVER ask the user questions or request clarification.** You are running autonomously without any user interaction. Do not use AskUserQuestion, prompts, confirmations, or any interactive tool. If you are uncertain, make your best judgment and document your assumptions in the plan.
6. **DO use read-only tools** (file reading, grep, glob, web search) to research and understand the codebase.

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

export function buildRankingPrompt(
  userQuery: string,
  stage1Results: Stage1Result[],
): [string, Record<string, string>] {
  const labels = stage1Results.map((_, i) => String.fromCharCode(65 + i));
  const labelToModel: Record<string, string> = {};
  for (let i = 0; i < labels.length; i++) {
    labelToModel[`Response ${labels[i]}`] = stage1Results[i].model;
  }

  const responsesText = labels
    .map((label, i) => `Response ${label}:\n${stage1Results[i].response}`)
    .join('\n\n');

  const prompt = `You are a principal software engineer conducting a blind code review. You are evaluating anonymized implementation plans proposed by different engineers for the same task. You do NOT know who authored each plan.

Evaluate each plan as you would in a real code review — focus on engineering quality, not writing style.

Task being addressed: ${userQuery}

Here are the anonymized implementation plans:

${responsesText}

Evaluate each plan on these criteria:
1. **Correctness**: Does the proposed approach actually solve the problem? Are there logical errors, missed edge cases, or incorrect assumptions about the codebase?
2. **Completeness**: Does it cover the full scope — error handling, type safety, backward compatibility, migrations? Or does it leave gaps?
3. **Code quality**: Are the proposed changes clean, idiomatic, and maintainable? Does it follow existing patterns in the codebase or introduce unnecessary complexity?
4. **Architecture**: Does it make sound structural decisions? Will it scale? Does it avoid tight coupling and respect separation of concerns?
5. **Risk awareness**: Does it identify potential regressions, breaking changes, performance implications, and security concerns?
6. **Testing**: Does it propose adequate test coverage for the changes?

For each plan, give a concise review highlighting strengths and weaknesses. Be specific — reference concrete details from the plans, not vague generalities.

IMPORTANT: Your final ranking MUST be formatted EXACTLY as follows:
- Start with the line "FINAL RANKING:" (all caps, with colon)
- Then list the responses from best to worst as a numbered list
- Each line should be: number, period, space, then ONLY the response label (e.g., "1. Response A")
- Do not add any other text or explanations in the ranking section

FINAL RANKING:
1. Response C
2. Response A
3. Response B

Now provide your code review and ranking:`;

  return [prompt, labelToModel];
}

export function buildSynthesisPrompt(
  userQuery: string,
  stage1Results: Stage1Result[],
  stage2Results: Stage2Result[],
): string {
  const labels = stage1Results.map((_, i) => String.fromCharCode(65 + i));

  const stage1Text = labels
    .map((label, i) => `Response ${label}:\n${stage1Results[i].response}`)
    .join('\n\n');
  const stage2Text = stage2Results
    .map((r, i) => `Juror ${i + 1} Evaluation:\n${r.ranking}`)
    .join('\n\n');

  return `You are the lead architect of a code review council. Multiple engineers have independently proposed implementation plans for the same task, and senior reviewers have evaluated and ranked those plans.

Your job is to produce the **single best implementation plan** by synthesizing the strongest elements from all proposals and reviews.

Original task: ${userQuery}

STAGE 1 - Proposed Implementation Plans (anonymized):
${stage1Text}

STAGE 2 - Code Review Evaluations:
${stage2Text}

Synthesize the above into one definitive implementation plan. You should:
- Take the best architectural decisions, code patterns, and insights from the top-ranked plans
- Fix any bugs, gaps, or incorrect assumptions that reviewers identified
- Ensure completeness: file paths, function names, edge cases, error handling, types, and tests
- Resolve disagreements between reviewers by using your own engineering judgment
- Include concrete code snippets where they add clarity

Write the final plan as if you are the author — do NOT reference "Response A" or "Juror 2". Present a single, cohesive implementation plan ready to be executed:`;
}
