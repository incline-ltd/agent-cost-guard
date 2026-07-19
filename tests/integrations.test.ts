import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function example(relativePath: string): Record<string, unknown> {
  const url = new URL(`../examples/${relativePath}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as Record<string, unknown>;
}

describe('published integration examples', () => {
  it.each([
    'claude-code/settings.json',
    'codex/hooks.json',
    'cursor/hooks.json',
    'github-copilot/copilot-cli.json',
    'github-copilot/copilot-cloud.json',
    'github-copilot/copilot-vscode.json',
  ])('%s is valid JSON', (path) => {
    expect(example(path)).toBeTypeOf('object');
  });

  it('configures Cursor to fail closed across every pre-tool call', () => {
    const config = example('cursor/hooks.json') as {
      hooks: { preToolUse: Array<Record<string, unknown>> };
    };
    expect(config.hooks.preToolUse).toHaveLength(1);
    expect(config.hooks.preToolUse[0]).toMatchObject({
      command: expect.stringContaining('hook cursor --strict'),
      failClosed: true,
    });
    expect(config.hooks.preToolUse[0]).not.toHaveProperty('matcher');
  });

  it('configures Codex PreToolUse in strict mode', () => {
    const config = example('codex/hooks.json') as {
      hooks: { PreToolUse: Array<{ hooks: Array<Record<string, unknown>> }> };
    };
    expect(config.hooks.PreToolUse[0]?.hooks[0]).toMatchObject({
      command: expect.stringContaining('hook codex --strict'),
      timeout: 10,
    });
  });

  it('configures Claude Code from the stable project root', () => {
    const config = example('claude-code/settings.json') as {
      hooks: { PreToolUse: Array<{ hooks: Array<Record<string, unknown>> }> };
    };
    expect(config.hooks.PreToolUse[0]?.hooks[0]).toMatchObject({
      command: expect.stringContaining(
        '${CLAUDE_PROJECT_DIR}/node_modules/.bin/agent-cost-guard',
      ),
      timeout: 10,
    });
  });

  it('configures Copilot CLI, cloud, and VS Code with their correct modes', () => {
    const interactive = example('github-copilot/copilot-cli.json') as {
      hooks: { preToolUse: Array<Record<string, unknown>> };
    };
    const cloud = example('github-copilot/copilot-cloud.json') as {
      hooks: { preToolUse: Array<Record<string, unknown>> };
    };
    const vscode = example('github-copilot/copilot-vscode.json') as {
      hooks: { preToolUse: Array<Record<string, unknown>> };
    };
    expect(interactive.hooks.preToolUse[0]).toMatchObject({
      bash: expect.stringContaining('--mode interactive --strict'),
      powershell: expect.stringContaining('--mode interactive --strict'),
      timeoutSec: 10,
    });
    expect(cloud.hooks.preToolUse[0]).toMatchObject({
      bash: expect.stringContaining('--mode cloud --strict'),
      timeoutSec: 10,
    });
    expect(vscode.hooks.preToolUse[0]).toMatchObject({
      bash: expect.stringContaining('--mode vscode --strict'),
      powershell: expect.stringContaining('--mode vscode --strict'),
      timeoutSec: 10,
    });
  });
});
