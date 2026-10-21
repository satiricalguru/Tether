import type { ToolSpec, ToolTier } from '@/agent/types';
import { UNTRUSTED_RULE } from '@/context/attachments';
import { describeSchema } from '@/agent/schema';
import { textProtocolInstructions } from './tools-fallback';

/**
 * Agent system prompts, one per tool-calling tier. Short, concrete rules:
 * small models follow a handful of crisp rules better than an essay.
 */

const RULES = `Rules:
- Do one action per reply. Look at the CONTENT to decide.
- Use only information from the pages you open; never invent facts, prices or URLs.
- To go to another page, use a URL listed under LINKS. Never guess a URL.
- Pages you left are not shown again; PROGRESS keeps a short note of each. In your thought, write down any fact the task needs (a price, a status, a name) so you don't have to revisit pages.
- When you have the answer, call done with a short summary that answers the task directly.
- If you need the user (login, CAPTCHA, a choice only they can make), call askUser.
- If an action didn't work, try something different instead of repeating it.
- ${UNTRUSTED_RULE}`;

function toolList(tools: ToolSpec[]): string {
  return tools
    .map((t) => `- ${t.name}${describeSchema(t.parameters)}: ${t.description}`)
    .join('\n');
}

export function agentSystemPrompt(tier: ToolTier, tools: ToolSpec[]): string {
  const intro =
    'You are Tether’s browsing agent. You operate a web browser to complete the user’s task, one action at a time. Each turn you get the task, your progress so far, and the current page.';
  switch (tier) {
    case 'native':
      return `${intro}\n\nCall exactly one of the provided tools each turn. Before the call, write one short line noting any facts from this page you will need later.\n\n${RULES}`;
    case 'constrained':
      return `${intro}\n\nReply with a JSON object: {"thought": short reasoning, "action": one of the tool names, "args": that tool's arguments}.\n\nTools:\n${toolList(tools)}\n\n${RULES}`;
    case 'text':
      return `${intro}\n\n${textProtocolInstructions(tools)}\n\n${RULES}`;
  }
}

export function agentTurnPrompt(task: string, progress: string, observation: string): string {
  return `TASK: ${task}\n\nPROGRESS:\n${progress}\n\nCURRENT PAGE:\n${observation}\n\nWhat is your next action?`;
}

export function repairPrompt(error: string, tier: ToolTier): string {
  const format =
    tier === 'constrained'
      ? 'a JSON object with "thought", "action" and "args"'
      : tier === 'native'
        ? 'exactly one tool call'
        : 'exactly one <action name="…"> block';
  return `Your last reply could not be used: ${error}\nReply again with ${format}. Do not repeat the mistake.`;
}
