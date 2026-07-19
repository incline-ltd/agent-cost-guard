import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';

interface Captured {
  code: number;
  out: string;
  err: string;
}

function run(args: string[], stdin?: string): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string): boolean => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string): boolean => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = main(args, stdin);
    return { code, out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe('cli inspect exit codes', () => {
  it('allow -> exit 0', () => {
    const r = run(['inspect', '--', 'aws', 'ec2', 'describe-instances']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Agent Cost Guard');
    expect(r.out).toContain('Decision: ALLOW');
    expect(r.out).toContain('Reason code: cost.no-match');
  });

  it('shows a small live status only for human TTY inspection', () => {
    const stderrDescriptor = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    try {
      const human = run(['inspect', '--', 'aws', 'ec2', 'describe-instances']);
      expect(human.err).toContain('⠋ Checking cost policy...');
      expect(human.err).toContain('✓ Cost policy checked.');

      const json = run(['inspect', '--json', '--', 'aws', 'ec2', 'describe-instances']);
      expect(json.err).toBe('');
    } finally {
      if (stderrDescriptor) Object.defineProperty(process.stderr, 'isTTY', stderrDescriptor);
      else Reflect.deleteProperty(process.stderr, 'isTTY');
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
  });

  it('approval-required -> exit 2 with the approval message', () => {
    const r = run(['inspect', '--', 'aws', 'ec2', 'run-instances', '--instance-type', 't3.small']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('Decision: APPROVAL REQUIRED');
    expect(r.out).toContain('Cost confirmation required:');
  });

  it('block -> exit 3', () => {
    const r = run(['inspect', '--', 'AGENT_COST_GUARD_DISABLED=1']);
    expect(r.code).toBe(3);
    expect(r.out).toContain('Decision: BLOCKED');
    expect(r.out).toContain('Reason code: guard.bypass');
  });

  it('--json emits parseable output', () => {
    const r = run(['inspect', '--json', '--', 'terraform', 'apply']);
    expect(r.code).toBe(2);
    const parsed = JSON.parse(r.out) as { decision: string; reasonCode: string };
    expect(parsed.decision).toBe('approval-required');
    expect(parsed.reasonCode).toBe('terraform.apply');
  });

  it('--strict blocks an incomplete shell command', () => {
    const r = run(['inspect', '--json', '--strict', '--', 'aws ec2 describe-instances "']);
    expect(r.code).toBe(3);
    const parsed = JSON.parse(r.out) as {
      decision: string;
      reasonCode: string;
      inspection: { complete: boolean };
    };
    expect(parsed.decision).toBe('block');
    expect(parsed.reasonCode).toBe('inspection.incomplete');
    expect(parsed.inspection.complete).toBe(false);
  });

  it('makes incomplete non-strict inspection visible in human output', () => {
    const r = run(['inspect', '--', 'aws ec2 describe-instances "']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Inspection: INCOMPLETE');
    expect(r.out).toContain('shell.unclosed-double-quote');
  });

  it('missing `--` is a usage error (exit 64)', () => {
    const r = run(['inspect']);
    expect(r.code).toBe(64);
    expect(r.err).toContain('inspect requires a command');
  });

  it('unknown command is a usage error (exit 64)', () => {
    const r = run(['frobnicate']);
    expect(r.code).toBe(64);
  });

  it('redacts sensitive values in usage diagnostics', () => {
    const secret = 'alpha bravo charlie';
    const r = run(['hook', 'claude-code', `--api-token=${secret}`]);
    expect(r.code).toBe(64);
    expect(r.err).toContain('--api-token=[REDACTED]');
    expect(r.err).not.toContain('alpha');
    expect(r.err).not.toContain('bravo');
    expect(r.err).not.toContain('charlie');
  });

  it('rejects flags not supported by the selected hook', () => {
    expect(run(['hook', 'claude-code', '--mode', 'cloud']).code).toBe(64);
    expect(run(['hook', 'claude-code', '--strict', '--no-strict']).code).toBe(64);
    expect(run(['hook', 'codex', '--mode', 'cloud']).code).toBe(64);
    expect(run(['hook', 'codex', '--strict', '--no-strict']).code).toBe(64);
    expect(run(['hook', 'cursor', '--mode', 'cloud']).code).toBe(64);
    expect(run(['hook', 'cursor', '--strict', '--no-strict']).code).toBe(64);
    expect(run(['hook', 'copilot', '--unknown']).code).toBe(64);
    expect(run(['hook', 'copilot', '--mode', 'cloud', '--mode=interactive']).code).toBe(64);
    expect(run(['hook', 'copilot', '--strict', '--no-strict']).code).toBe(64);
  });

  it('routes Codex hooks without emitting unsupported ask', () => {
    const safe = run(
      ['hook', 'codex'],
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'aws s3 ls' } }),
    );
    expect(safe.code).toBe(0);
    expect(safe.out).toBe('');

    const cost = run(
      ['hook', 'codex'],
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'terraform apply' } }),
    );
    expect(cost.code).toBe(0);
    expect(JSON.parse(cost.out).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(cost.out).not.toContain('"permissionDecision":"ask"');
  });

  it('routes Cursor hooks with a neutral allow and authoritative deny', () => {
    const safe = run(
      ['hook', 'cursor'],
      JSON.stringify({ tool_name: 'Shell', tool_input: { command: 'aws s3 ls' } }),
    );
    expect(safe.code).toBe(0);
    expect(safe.out).toBe('{}\n');

    const cost = run(
      ['hook', 'cursor'],
      JSON.stringify({ tool_name: 'Shell', tool_input: { command: 'terraform apply' } }),
    );
    expect(cost.code).toBe(0);
    expect(JSON.parse(cost.out).permission).toBe('deny');
  });

  it('routes VS Code Copilot hooks with the VS Code decision envelope', () => {
    const bypass = run(
      ['hook', 'copilot', '--mode', 'vscode'],
      JSON.stringify({
        tool_name: 'runTerminalCommand',
        tool_input: { command: 'AGENT_COST_GUARD_DISABLED=1 true' },
      }),
    );
    expect(bypass.code).toBe(0);
    expect(JSON.parse(bypass.out).hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
    });
  });

  it('denies oversized injected stdin with valid strict host output', () => {
    const oversized = 'x'.repeat(1024 * 1024 + 1);
    const cases = [
      { args: ['hook', 'claude-code'], decisionPath: ['hookSpecificOutput', 'permissionDecision'] },
      { args: ['hook', 'codex'], decisionPath: ['hookSpecificOutput', 'permissionDecision'] },
      { args: ['hook', 'cursor'], decisionPath: ['permission'] },
      { args: ['hook', 'copilot'], decisionPath: ['permissionDecision'] },
      {
        args: ['hook', 'copilot', '--mode', 'cloud'],
        decisionPath: ['permissionDecision'],
      },
      {
        args: ['hook', 'copilot', '--mode', 'vscode'],
        decisionPath: ['hookSpecificOutput', 'permissionDecision'],
      },
    ];

    for (const testCase of cases) {
      const result = run(testCase.args, oversized);
      expect(result.code).toBe(0);
      let value: unknown = JSON.parse(result.out) as unknown;
      for (const key of testCase.decisionPath) {
        value = (value as Record<string, unknown>)[key];
      }
      expect(value).toBe('deny');
    }
  });

  it('preserves non-strict deferral for oversized injected hook stdin', () => {
    const oversized = 'x'.repeat(1024 * 1024 + 1);
    expect(run(['hook', 'claude-code', '--no-strict'], oversized).out).toBe('');
    expect(run(['hook', 'codex', '--no-strict'], oversized).out).toBe('');
    expect(run(['hook', 'cursor', '--no-strict'], oversized).out).toBe('{}\n');
    expect(run(['hook', 'copilot', '--no-strict'], oversized).out).toBe('');
  });
});

describe('cli inspect-json', () => {
  it('inspects a validated structured tool request from stdin', () => {
    const input = JSON.stringify({
      source: 'ci',
      mode: 'non-interactive',
      action: { kind: 'tool', name: 'create_database', arguments: { name: 'fake-db' } },
    });
    const r = run(['inspect-json', '--strict'], input);
    expect(r.code).toBe(2);
    const parsed = JSON.parse(r.out) as { decision: string; reasonCode: string };
    expect(parsed.decision).toBe('approval-required');
    expect(parsed.reasonCode).toBe('generic.tool.cost-bearing-name');
  });

  it('returns usage 64 for empty, malformed, or invalid requests', () => {
    expect(run(['inspect-json'], '').code).toBe(64);
    expect(run(['inspect-json'], '{not-json').code).toBe(64);
    expect(
      run(
        ['inspect-json'],
        JSON.stringify({ source: 'ci', mode: 'non-interactive', action: { kind: 'shell' } }),
      ).code,
    ).toBe(64);
  });

  it('does not echo malformed JSON that may contain a secret', () => {
    const secret = 'fake-super-secret-value';
    const r = run(['inspect-json'], `{"password":"${secret}"`);
    expect(r.code).toBe(64);
    expect(r.err).not.toContain(secret);
  });

  it('rejects unsupported flags', () => {
    expect(run(['inspect-json', '--json'], '{}').code).toBe(64);
  });

  it('rejects oversized injected stdin before JSON parsing', () => {
    const secret = 'fake-sensitive-padding';
    const r = run(['inspect-json'], `${secret}${'x'.repeat(1024 * 1024)}`);
    expect(r.code).toBe(64);
    expect(r.out).toBe('');
    expect(r.err).toContain('inspect-json stdin exceeds the 1 MiB limit.');
    expect(r.err).not.toContain(secret);
  });

  it('measures the stdin limit in UTF-8 bytes', () => {
    const r = run(['inspect-json'], 'é'.repeat(600_000));
    expect(r.code).toBe(64);
    expect(r.err).toContain('inspect-json stdin exceeds the 1 MiB limit.');
  });
});

describe('cli rules', () => {
  it('rules list prints rule ids', () => {
    const r = run(['rules', 'list']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('aws.ec2.run-instances');
  });

  it('rules list --json is valid JSON', () => {
    const r = run(['rules', 'list', '--json']);
    const parsed = JSON.parse(r.out) as Array<{ id: string }>;
    expect(parsed.some((rule) => rule.id === 'terraform.apply')).toBe(true);
  });

  it('rules explain shows an approval block', () => {
    const r = run(['rules', 'explain', 'aws.ec2.run-instances']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('EC2 instance');
  });

  it('rules explain on an unknown id is a usage error', () => {
    const r = run(['rules', 'explain', 'does.not.exist']);
    expect(r.code).toBe(64);
  });

  it('redacts an unknown sensitive-looking rule id', () => {
    const r = run(['rules', 'explain', 'api_token=alpha bravo charlie']);
    expect(r.code).toBe(64);
    expect(r.err).toContain('api_token=[REDACTED]');
    expect(r.err).not.toContain('alpha');
    expect(r.err).not.toContain('bravo');
    expect(r.err).not.toContain('charlie');
  });

  it('rejects unsupported rule arguments', () => {
    expect(run(['rules', 'list', '--verbose']).code).toBe(64);
    expect(run(['rules', 'explain', 'terraform.apply', 'extra']).code).toBe(64);
  });
});

describe('cli meta', () => {
  it('doctor reports local core and adapter status without claiming host installation', () => {
    const r = run(['doctor']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Core inspection: checking... working');
    expect(r.out).toContain('Claude Code adapter: checking... working');
    expect(r.out).toContain('Codex adapter: checking... working');
    expect(r.out).toContain('Cursor adapter: checking... working');
    expect(r.out).toContain('GitHub Copilot CLI adapter: checking... working');
    expect(r.out).toContain('GitHub Copilot for VS Code adapter: checking... working');
    expect(r.out).toContain('Local verification: passed');
    expect(r.out).toContain('Host hook installation: not checked');
  });

  it('doctor rejects unsupported arguments', () => {
    const r = run(['doctor', '--json']);
    expect(r.code).toBe(64);
    expect(r.err).toContain('doctor does not accept arguments');
  });

  it('--version prints a version', () => {
    const r = run(['--version']);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('--help prints usage', () => {
    const r = run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage:');
  });
});
