import { describe, expect, it } from 'vitest';
import { runClaudeCodeHook } from '../src/adapters/claude-code.js';
import { runCodexHook } from '../src/adapters/codex.js';
import { runCursorHook } from '../src/adapters/cursor.js';
import { runCopilotHook } from '../src/adapters/github-copilot.js';
import type { Rule } from '../src/core/rules.js';
import {
  claudeAdapterCases,
  codexAdapterCases,
  copilotAdapterCases,
  cursorAdapterCases,
} from './helpers/fixtures.js';

function rawFor(input?: Record<string, unknown>, rawInput?: string): string {
  if (rawInput !== undefined) return rawInput;
  return JSON.stringify(input ?? {});
}

const brokenRule = {
  id: 'test.invalid-regex',
  version: '1',
  provider: 'test',
  category: 'test',
  actionForm: 'tool',
  decision: 'block',
  reasonCode: 'test.invalid-regex',
  summary: 'test',
  priority: 1,
  match: { toolNameRegex: '[' },
} satisfies Rule;

describe('Claude Code adapter', () => {
  for (const testCase of claudeAdapterCases()) {
    it(testCase.name, () => {
      const raw = rawFor(testCase.input, testCase.rawInput);
      const result = runClaudeCodeHook(raw, { strict: testCase.strict ?? false });
      expect(result.exitCode).toBe(testCase.expect.exitCode);

      if (testCase.expect.empty) {
        expect(result.stdout).toBe('');
        return;
      }
      const parsed = JSON.parse(result.stdout) as {
        hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
      };
      expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(parsed.hookSpecificOutput.permissionDecision).toBe(testCase.expect.permissionDecision);
      if (testCase.expect.reasonIncludes) {
        expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(testCase.expect.reasonIncludes);
      }
    });
  }

  it('never emits permissionDecision "allow"', () => {
    const commands = [
      'aws ec2 run-instances --instance-type t3.small',
      'aws ec2 describe-instances',
      'terraform apply',
      'export AGENT_COST_GUARD_DISABLED=1',
    ];
    for (const command of commands) {
      const raw = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
      const { stdout } = runClaudeCodeHook(raw);
      expect(stdout).not.toContain('"permissionDecision":"allow"');
    }
  });

  it('strict mode denies recognized shell tools with uninspectable arguments', () => {
    const raw = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 42 } });
    const { stdout } = runClaudeCodeHook(raw, { strict: true });
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('completely inspected');
  });
});

describe('GitHub Copilot adapter', () => {
  for (const testCase of copilotAdapterCases()) {
    it(testCase.name, () => {
      const raw = rawFor(testCase.input, testCase.rawInput);
      const result = runCopilotHook(raw, { strict: testCase.strict ?? false, mode: testCase.mode });
      expect(result.exitCode).toBe(testCase.expect.exitCode);

      if (testCase.expect.empty) {
        expect(result.stdout).toBe('');
        return;
      }
      const parsed = JSON.parse(result.stdout) as {
        permissionDecision: string;
        permissionDecisionReason: string;
      };
      expect(parsed.permissionDecision).toBe(testCase.expect.permissionDecision);
      if (testCase.expect.reasonIncludes) {
        expect(parsed.permissionDecisionReason).toContain(testCase.expect.reasonIncludes);
      }
    });
  }

  it('cloud mode turns approval-required into deny with the approval message', () => {
    const raw = JSON.stringify({ toolName: 'bash', toolArgs: { command: 'aws s3 mb s3://x' } });
    const { stdout } = runCopilotHook(raw, { mode: 'cloud' });
    const parsed = JSON.parse(stdout) as { permissionDecision: string; permissionDecisionReason: string };
    expect(parsed.permissionDecision).toBe('deny');
    expect(parsed.permissionDecisionReason).toContain('Cost confirmation required:');
  });

  it('interactive mode uses ask for approval-required', () => {
    const raw = JSON.stringify({ toolName: 'bash', toolArgs: { command: 'aws s3 mb s3://x' } });
    const { stdout } = runCopilotHook(raw, { mode: 'interactive' });
    const parsed = JSON.parse(stdout) as { permissionDecision: string };
    expect(parsed.permissionDecision).toBe('ask');
  });

  it('VS Code mode uses its nested decision envelope and native shell tool name', () => {
    const raw = JSON.stringify({
      tool_name: 'runTerminalCommand',
      tool_input: { command: 'terraform apply fake.plan' },
    });
    const { stdout } = runCopilotHook(raw, { mode: 'vscode', strict: true });
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: {
        hookEventName: string;
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
      'Cost confirmation required:',
    );
  });

  it('VS Code mode blocks a guard bypass before terminal execution', () => {
    const raw = JSON.stringify({
      tool_name: 'runTerminalCommand',
      tool_input: { command: 'AGENT_COST_GUARD_DISABLED=1 true' },
    });
    const { stdout } = runCopilotHook(raw, { mode: 'vscode', strict: true });
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('bypass');
  });

  it('never emits permissionDecision "allow" in any mode', () => {
    for (const mode of ['interactive', 'cloud', 'vscode'] as const) {
      const raw = JSON.stringify({ toolName: 'bash', toolArgs: { command: 'aws ec2 describe-instances' } });
      const { stdout } = runCopilotHook(raw, { mode });
      expect(stdout).not.toContain('"permissionDecision":"allow"');
    }
  });

  it('parses native JSON-string toolArgs and PowerShell tool names', () => {
    const raw = JSON.stringify({
      toolName: 'powershell',
      toolArgs: JSON.stringify({ command: 'terraform apply' }),
    });
    const { stdout } = runCopilotHook(raw, { mode: 'interactive', strict: true });
    const parsed = JSON.parse(stdout) as { permissionDecision: string };
    expect(parsed.permissionDecision).toBe('ask');
  });

  it('inspects native create tool JSON-string arguments', () => {
    const raw = JSON.stringify({
      toolName: 'create',
      toolArgs: JSON.stringify({
        path: 'main.tf',
        file_text: 'resource "aws_instance" "web" {}',
      }),
    });
    const { stdout } = runCopilotHook(raw, { mode: 'cloud', strict: true });
    const parsed = JSON.parse(stdout) as { permissionDecision: string; permissionDecisionReason: string };
    expect(parsed.permissionDecision).toBe('deny');
    expect(parsed.permissionDecisionReason).toContain('Terraform-managed provider');
  });

  it('fails closed with protocol output when inspection throws', () => {
    const raw = JSON.stringify({ toolName: 'get_weather', toolArgs: '{}' });
    const { stdout } = runCopilotHook(raw, {
      mode: 'cloud',
      strict: true,
      inspectOptions: { rules: [brokenRule] },
    });
    const parsed = JSON.parse(stdout) as { permissionDecision: string; permissionDecisionReason: string };
    expect(parsed.permissionDecision).toBe('deny');
    expect(parsed.permissionDecisionReason).toContain('internal inspection failed');
  });
});

describe('Codex adapter', () => {
  for (const testCase of codexAdapterCases()) {
    it(testCase.name, () => {
      const result = runCodexHook(rawFor(testCase.input, testCase.rawInput), {
        strict: testCase.strict ?? false,
      });
      expect(result.exitCode).toBe(testCase.expect.exitCode);

      if (testCase.expect.empty) {
        expect(result.stdout).toBe('');
        return;
      }
      const parsed = JSON.parse(result.stdout) as {
        hookSpecificOutput: {
          hookEventName: string;
          permissionDecision: string;
          permissionDecisionReason: string;
        };
      };
      expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(parsed.hookSpecificOutput.permissionDecision).toBe(
        testCase.expect.permissionDecision,
      );
      if (testCase.expect.reasonIncludes) {
        expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
          testCase.expect.reasonIncludes,
        );
      }
    });
  }

  it('never emits allow or unsupported ask', () => {
    for (const command of ['aws ec2 describe-instances', 'terraform apply']) {
      const { stdout } = runCodexHook(
        JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      );
      expect(stdout).not.toContain('"permissionDecision":"allow"');
      expect(stdout).not.toContain('"permissionDecision":"ask"');
    }
  });

  it('fails closed with Codex protocol output when inspection throws', () => {
    const { stdout } = runCodexHook(
      JSON.stringify({ tool_name: 'get_weather', tool_input: {} }),
      { strict: true, inspectOptions: { rules: [brokenRule] } },
    );
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
      'internal inspection failed',
    );
  });

  it('does not expose secrets from a denied command', () => {
    const fakeSecret = 'fake multiword password';
    const { stdout } = runCodexHook(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: {
          command: `aws rds create-db-instance --master-user-password "${fakeSecret}"`,
        },
      }),
    );
    expect(stdout).toContain('"permissionDecision":"deny"');
    expect(stdout).not.toContain(fakeSecret);
  });
});

describe('Cursor adapter', () => {
  for (const testCase of cursorAdapterCases()) {
    it(testCase.name, () => {
      const result = runCursorHook(rawFor(testCase.input, testCase.rawInput), {
        strict: testCase.strict ?? false,
      });
      expect(result.exitCode).toBe(testCase.expect.exitCode);

      const parsed = JSON.parse(result.stdout) as {
        permission?: string;
        user_message?: string;
        agent_message?: string;
      };
      if (testCase.expect.neutral) {
        expect(result.stdout).toBe('{}');
        expect(parsed).toEqual({});
        return;
      }
      expect(parsed.permission).toBe(testCase.expect.permission);
      expect(parsed.agent_message).toBe(parsed.user_message);
      if (testCase.expect.reasonIncludes) {
        expect(parsed.user_message).toContain(testCase.expect.reasonIncludes);
      }
    });
  }

  it('never emits allow or unsupported ask', () => {
    for (const command of ['aws ec2 describe-instances', 'terraform apply']) {
      const { stdout } = runCursorHook(
        JSON.stringify({ tool_name: 'Shell', tool_input: { command } }),
      );
      expect(stdout).not.toContain('"permission":"allow"');
      expect(stdout).not.toContain('"permission":"ask"');
    }
  });

  it('fails closed with Cursor protocol output when inspection throws', () => {
    const { stdout } = runCursorHook(
      JSON.stringify({ tool_name: 'get_weather', tool_input: {} }),
      { strict: true, inspectOptions: { rules: [brokenRule] } },
    );
    const parsed = JSON.parse(stdout) as { permission: string; user_message: string };
    expect(parsed.permission).toBe('deny');
    expect(parsed.user_message).toContain('internal inspection failed');
  });

  it('does not expose secrets from a denied command', () => {
    const fakeSecret = 'fake multiword password';
    const { stdout } = runCursorHook(
      JSON.stringify({
        tool_name: 'Shell',
        tool_input: {
          command: `aws rds create-db-instance --master-user-password "${fakeSecret}"`,
        },
      }),
    );
    expect(stdout).toContain('"permission":"deny"');
    expect(stdout).not.toContain(fakeSecret);
  });
});
