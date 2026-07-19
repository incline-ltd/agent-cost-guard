/**
 * OpenAI Codex PreToolUse adapter.
 *
 * Codex does not currently enforce an "ask" response. Cost approvals and
 * policy blocks therefore both map to "deny" with the full reason. A core
 * allow emits no output, leaving Codex's own permission flow in control.
 *
 * Reference: https://learn.chatgpt.com/docs/hooks#pretooluse
 */

import { reasonText } from '../format/output.js';
import {
  inspectTool,
  parseHookInput,
  toToolAction,
  type AdapterOptions,
  type HookResult,
} from './shared.js';

const ALLOW: HookResult = { stdout: '', exitCode: 0 };

function denyOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

function deny(reason: string): HookResult {
  return { stdout: denyOutput(reason), exitCode: 0 };
}

export function runCodexHook(raw: string, options: AdapterOptions = {}): HookResult {
  const input = parseHookInput(raw);
  const action = input ? toToolAction(input.tool_name, input.tool_input) : null;

  if (!action) {
    return options.strict
      ? deny('agent-cost-guard: could not parse PreToolUse input in strict mode.')
      : ALLOW;
  }

  try {
    const decision = inspectTool('codex', 'interactive', action, options);
    return decision.decision === 'allow' ? ALLOW : deny(reasonText(decision));
  } catch {
    return deny('agent-cost-guard: internal inspection failed; the tool call was denied.');
  }
}
