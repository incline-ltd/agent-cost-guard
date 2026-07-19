/**
 * Claude Code PreToolUse adapter.
 *
 * Reads the hook JSON, inspects the proposed tool call, and maps the decision
 * to Claude Code's structured hook output:
 *   allow            -> no output (normal permission flow continues)
 *   approval-required -> permissionDecision "ask" + approval message
 *   block            -> permissionDecision "deny" + reason
 *
 * It never emits permissionDecision "allow", so it can never auto-approve a
 * tool call or weaken Claude Code's own permission system.
 *
 * Reference: https://code.claude.com/docs/en/hooks
 */

import { reasonText } from '../format/output.js';
import {
  parseHookInput,
  toToolAction,
  inspectTool,
  type AdapterOptions,
  type HookResult,
} from './shared.js';

const ALLOW: HookResult = { stdout: '', exitCode: 0 };

function hookOutput(permissionDecision: 'ask' | 'deny', reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
      permissionDecisionReason: reason,
    },
  });
}

export function runClaudeCodeHook(raw: string, options: AdapterOptions = {}): HookResult {
  const input = parseHookInput(raw);
  const action = input ? toToolAction(input.tool_name, input.tool_input) : null;

  if (!action) {
    if (options.strict) {
      return {
        stdout: hookOutput(
          'deny',
          'agent-cost-guard: could not parse PreToolUse input in strict mode.',
        ),
        exitCode: 0,
      };
    }
    return ALLOW;
  }

  let decision: ReturnType<typeof inspectTool>;
  try {
    decision = inspectTool('claude-code', 'interactive', action, options);
  } catch {
    return {
      stdout: hookOutput(
        'deny',
        'agent-cost-guard: internal inspection failed; the tool call was denied.',
      ),
      exitCode: 0,
    };
  }

  switch (decision.decision) {
    case 'allow':
      return ALLOW;
    case 'approval-required':
      return { stdout: hookOutput('ask', reasonText(decision)), exitCode: 0 };
    case 'block':
      return { stdout: hookOutput('deny', reasonText(decision)), exitCode: 0 };
  }
}
