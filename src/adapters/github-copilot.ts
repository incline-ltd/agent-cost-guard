/**
 * GitHub Copilot CLI, cloud agent, and VS Code PreToolUse adapter.
 *
 * Reads the hook JSON, inspects the proposed tool call, and maps the decision
 * to Copilot's decision output. In interactive mode a cost action escalates to
 * "ask"; in cloud/coding-agent mode no human can answer, so approval-required
 * becomes "deny" carrying the exact approval message.
 *
 *   interactive: allow -> no output, approval-required -> ask, block -> deny
 *   cloud:       allow -> no output, approval-required -> deny, block -> deny
 *   vscode:      allow -> no output, approval-required -> ask, block -> deny
 *
 * It never emits permissionDecision "allow", so it never weakens Copilot's own
 * permission system.
 *
 * Reference: https://docs.github.com/en/copilot/reference/hooks-reference
 */

import { reasonText } from '../format/output.js';
import {
  parseHookInput,
  toToolAction,
  inspectTool,
  type AdapterOptions,
  type HookResult,
} from './shared.js';

export type CopilotMode = 'interactive' | 'cloud' | 'vscode';

const ALLOW: HookResult = { stdout: '', exitCode: 0 };

function copilotDecisionOutput(permissionDecision: 'ask' | 'deny', reason: string): string {
  return JSON.stringify({ permissionDecision, permissionDecisionReason: reason });
}

function vscodeDecisionOutput(permissionDecision: 'ask' | 'deny', reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
      permissionDecisionReason: reason,
    },
  });
}

function decisionOutput(
  mode: CopilotMode,
  permissionDecision: 'ask' | 'deny',
  reason: string,
): string {
  return mode === 'vscode'
    ? vscodeDecisionOutput(permissionDecision, reason)
    : copilotDecisionOutput(permissionDecision, reason);
}

export interface CopilotAdapterOptions extends AdapterOptions {
  mode?: CopilotMode;
}

export function runCopilotHook(raw: string, options: CopilotAdapterOptions = {}): HookResult {
  const mode: CopilotMode = options.mode ?? 'interactive';
  const input = parseHookInput(raw);
  const name = input?.toolName ?? input?.tool_name;
  const args = input?.toolArgs ?? input?.tool_input ?? input?.arguments;
  const action = input ? toToolAction(name, args) : null;

  if (!action) {
    if (options.strict) {
      return {
        stdout: decisionOutput(
          mode,
          'deny',
          'agent-cost-guard: could not parse preToolUse input in strict mode.',
        ),
        exitCode: 0,
      };
    }
    return ALLOW;
  }

  let decision: ReturnType<typeof inspectTool>;
  try {
    decision = inspectTool(
      'github-copilot',
      mode === 'cloud' ? 'non-interactive' : 'interactive',
      action,
      options,
    );
  } catch {
    return {
      stdout: decisionOutput(
        mode,
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
      // Cloud agents cannot prompt a human, so the request must deny with the
      // exact approval message rather than ask.
      return {
        stdout: decisionOutput(
          mode,
          mode === 'cloud' ? 'deny' : 'ask',
          reasonText(decision),
        ),
        exitCode: 0,
      };
    case 'block':
      return { stdout: decisionOutput(mode, 'deny', reasonText(decision)), exitCode: 0 };
  }
}
