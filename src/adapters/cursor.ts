/**
 * Cursor preToolUse adapter.
 *
 * Cursor requires valid JSON when failClosed is enabled. A core allow returns
 * the neutral object `{}` so Cursor continues to its native permission checks.
 * Cursor does not reliably enforce "ask", so approvals and blocks both map to
 * "deny" with the full redacted reason.
 *
 * Reference: https://cursor.com/docs/hooks
 */

import { reasonText } from '../format/output.js';
import {
  inspectTool,
  parseHookInput,
  toToolAction,
  type AdapterOptions,
  type HookResult,
} from './shared.js';

const ALLOW: HookResult = { stdout: '{}', exitCode: 0 };

function denyOutput(reason: string): string {
  return JSON.stringify({
    permission: 'deny',
    user_message: reason,
    agent_message: reason,
  });
}

function deny(reason: string): HookResult {
  return { stdout: denyOutput(reason), exitCode: 0 };
}

export function runCursorHook(raw: string, options: AdapterOptions = {}): HookResult {
  const input = parseHookInput(raw);
  const action = input ? toToolAction(input.tool_name, input.tool_input) : null;

  if (!action) {
    return options.strict
      ? deny('agent-cost-guard: could not parse preToolUse input in strict mode.')
      : ALLOW;
  }

  try {
    const decision = inspectTool('cursor', 'interactive', action, options);
    return decision.decision === 'allow' ? ALLOW : deny(reasonText(decision));
  } catch {
    return deny('agent-cost-guard: internal inspection failed; the tool call was denied.');
  }
}
