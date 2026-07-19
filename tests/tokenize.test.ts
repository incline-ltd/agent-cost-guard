import { describe, expect, it } from 'vitest';
import { containsSequence, parseShell, parseShellCommand } from '../src/core/tokenize.js';

describe('parseShellCommand', () => {
  it('splits a compound command into segments', () => {
    const cmds = parseShellCommand('echo hi && aws s3 mb s3://demo');
    expect(cmds).toHaveLength(2);
    expect(cmds[0]?.bin).toBe('echo');
    expect(cmds[1]?.bin).toBe('aws');
    expect(cmds[1]?.positionals).toEqual(['s3', 'mb', 's3://demo']);
  });

  it('captures leading environment assignments without treating them as bin', () => {
    const [cmd] = parseShellCommand('AWS_REGION=us-east-1 FOO=bar aws ec2 run-instances');
    expect(cmd?.env).toEqual({ AWS_REGION: 'us-east-1', FOO: 'bar' });
    expect(cmd?.bin).toBe('aws');
  });

  it('parses flags with values and equals form', () => {
    const [cmd] = parseShellCommand('aws ec2 run-instances --instance-type t3.small --count=3');
    expect(cmd?.flags.get('--instance-type')).toBe('t3.small');
    expect(cmd?.flags.get('--count')).toBe('3');
  });

  it('treats a boolean flag before a subcommand as a positional (contiguous match keeps subcommand)', () => {
    const [cmd] = parseShellCommand('wrangler --experimental deploy');
    expect(cmd?.positionals).toContain('deploy');
  });

  it('finds a subcommand after leading global value-flags', () => {
    const [cmd] = parseShellCommand('aws --region us-east-1 ec2 run-instances');
    expect(containsSequence(cmd?.positionals ?? [], ['ec2', 'run-instances'])).toBe(true);
  });

  it('unwraps sudo and env wrappers', () => {
    const [sudoCmd] = parseShellCommand('sudo aws ec2 run-instances');
    expect(sudoCmd?.bin).toBe('aws');
    const [envCmd] = parseShellCommand('env FOO=bar aws s3 mb s3://x');
    expect(envCmd?.bin).toBe('aws');
    expect(envCmd?.env).toEqual({ FOO: 'bar' });
  });

  it('expands sh -c wrapped commands', () => {
    const cmds = parseShellCommand('bash -c "aws ec2 run-instances --instance-type t3.small"');
    const bins = cmds.map((c) => c.bin);
    expect(bins).toContain('bash');
    expect(bins).toContain('aws');
  });

  it('inspects login-shell command strings', () => {
    const bins = parseShellCommand('zsh -lc "terraform apply"').map((command) => command.bin);
    expect(bins).toContain('terraform');
  });

  it('unwraps common JavaScript package runners', () => {
    const inputs = [
      'npx wrangler deploy',
      'npm exec -- wrangler deploy',
      'pnpm dlx wrangler deploy',
      'yarn wrangler deploy',
      'bunx wrangler deploy',
    ];
    for (const input of inputs) {
      const [command] = parseShellCommand(input);
      expect(command?.bin, input).toBe('wrangler');
      expect(command?.positionals, input).toContain('deploy');
    }
  });

  it('lexically inspects active command substitutions without expanding them', () => {
    const dollarBins = parseShellCommand('echo "$(aws ec2 run-instances)"').map((command) => command.bin);
    expect(dollarBins).toContain('aws');

    const backtickBins = parseShellCommand('echo `terraform apply`').map((command) => command.bin);
    expect(backtickBins).toContain('terraform');
  });

  it('inspects literal eval text and marks dynamic eval incomplete', () => {
    const literal = parseShell('eval "terraform apply"');
    expect(literal.commands.map((command) => command.bin)).toContain('terraform');
    expect(literal.complete).toBe(true);

    const dynamic = parseShell('eval "$CLOUD_COMMAND"');
    expect(dynamic.complete).toBe(false);
    expect(dynamic.issues).toContain('shell.dynamic-eval');
  });

  it('reports incomplete lexical forms', () => {
    const parsed = parseShell('echo "$(terraform apply"');
    expect(parsed.complete).toBe(false);
    expect(parsed.issues.length).toBeGreaterThan(0);

    expect(parseShell('aws ec2 describe-instances \\').complete).toBe(false);
    expect(parseShell('(aws ec2 describe-instances').complete).toBe(false);
    expect(parseShell('aws ec2 describe-instances)').complete).toBe(false);
  });

  it('strips comments and honours quotes', () => {
    const cmds = parseShellCommand('# aws ec2 run-instances');
    expect(cmds).toHaveLength(0);
    const [quoted] = parseShellCommand("aws s3 mb 's3://my demo bucket'");
    expect(quoted?.positionals).toEqual(['s3', 'mb', 's3://my demo bucket']);
  });

  it('drops redirections and their targets', () => {
    const [cmd] = parseShellCommand('aws ec2 describe-instances > out.json');
    expect(cmd?.positionals).toEqual(['ec2', 'describe-instances']);
  });

  it('does not expand variables or command substitutions', () => {
    const [cmd] = parseShellCommand('aws s3 mb s3://$BUCKET');
    // The literal token is preserved; no expansion happens.
    expect(cmd?.positionals).toEqual(['s3', 'mb', 's3://$BUCKET']);
  });
});

describe('containsSequence', () => {
  it('matches a contiguous run', () => {
    expect(containsSequence(['a', 'ec2', 'run-instances', 'b'], ['ec2', 'run-instances'])).toBe(true);
  });
  it('rejects a non-contiguous run', () => {
    expect(containsSequence(['ec2', 'x', 'run-instances'], ['ec2', 'run-instances'])).toBe(false);
  });
  it('an empty sequence always matches', () => {
    expect(containsSequence([], [])).toBe(true);
  });
});
