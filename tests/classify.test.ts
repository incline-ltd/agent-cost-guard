import { describe, expect, it } from 'vitest';
import { inspect } from '../src/core/classify.js';
import { reasonText } from '../src/format/output.js';
import type { InspectionRequest } from '../src/core/types.js';
import {
  fileChangeCases,
  shellCases,
  shellRequest,
  toolCases,
} from './helpers/fixtures.js';

describe('shell classification', () => {
  for (const testCase of shellCases()) {
    it(`${testCase.group}: ${testCase.name}`, () => {
      const decision = inspect(shellRequest(testCase.command));
      expect(decision.decision, testCase.command).toBe(testCase.expect.decision);
      if (testCase.expect.reasonCode) {
        expect(decision.reasonCode).toBe(testCase.expect.reasonCode);
      }
      if (decision.decision === 'approval-required') {
        expect(decision.approval).toBeDefined();
        expect(decision.approval?.provider.length).toBeGreaterThan(0);
        expect(decision.approval?.price.length).toBeGreaterThan(0);
      }
      if (decision.decision === 'allow') {
        expect(decision.matches).toHaveLength(0);
        expect(decision.approval).toBeUndefined();
      }
    });
  }
});

describe('tool classification and routing', () => {
  for (const testCase of toolCases()) {
    it(`${testCase.group}: ${testCase.name}`, () => {
      const request: InspectionRequest = {
        source: 'github-copilot',
        mode: 'interactive',
        action: testCase.action,
      };
      const decision = inspect(request);
      expect(decision.decision, testCase.name).toBe(testCase.expect.decision);
      if (testCase.expect.reasonCode) {
        expect(decision.reasonCode).toBe(testCase.expect.reasonCode);
      }
    });
  }
});

describe('file-change (Terraform) classification', () => {
  for (const testCase of fileChangeCases()) {
    it(`${testCase.group}: ${testCase.name}`, () => {
      const request: InspectionRequest = {
        source: 'claude-code',
        mode: 'interactive',
        action: testCase.action,
      };
      const decision = inspect(request);
      expect(decision.decision, testCase.name).toBe(testCase.expect.decision);
      if (testCase.expect.reasonCode) {
        expect(decision.reasonCode).toBe(testCase.expect.reasonCode);
      }
    });
  }
});

describe('decision invariants', () => {
  it('block wins over approval in a compound command', () => {
    const decision = inspect(shellRequest('AGENT_COST_GUARD_DISABLED=1 terraform apply'));
    expect(decision.decision).toBe('block');
    expect(decision.reasonCode).toBe('guard.bypass');
  });

  it('approval message always contains the required fields', () => {
    const decision = inspect(shellRequest('aws ec2 run-instances --instance-type t3.small'));
    expect(decision.decision).toBe('approval-required');
    const approval = decision.approval;
    expect(approval).toBeDefined();
    expect(approval?.provider).toBeTruthy();
    expect(approval?.resource).toBeTruthy();
    expect(approval?.billing).toBeTruthy();
    expect(approval?.price).toBeTruthy();
  });

  it('allow carries no approval and no matches', () => {
    const decision = inspect(shellRequest('aws ec2 describe-instances'));
    expect(decision.decision).toBe('allow');
    expect(decision.approval).toBeUndefined();
    expect(decision.matches).toHaveLength(0);
    expect(decision.reasonCode).toBe('cost.no-match');
  });

  it('orders matches globally by rule priority, not command segment order', () => {
    const decision = inspect(shellRequest('billingctl plan upgrade && aws s3 mb s3://demo'));
    expect(decision.reasonCode).toBe('aws.s3.mb');
    expect(decision.matches.map((match) => match.ruleId)).toEqual([
      'aws.s3.mb',
      'generic.plan-upgrade',
    ]);
  });

  it('retains and renders every distinct approval in a compound command', () => {
    const decision = inspect(shellRequest('terraform apply && aws ec2 run-instances'));
    expect(decision.approvals).toHaveLength(2);
    expect(reasonText(decision)).toContain('EC2 instance(s)');
    expect(reasonText(decision)).toContain('planned infrastructure changes');
  });

  it('marks incomplete inspection and blocks it in strict mode', () => {
    const request: InspectionRequest = {
      source: 'claude-code',
      mode: 'interactive',
      action: { kind: 'tool', name: 'Bash', arguments: {} },
    };
    const permissive = inspect(request);
    expect(permissive.decision).toBe('allow');
    expect(permissive.inspection.complete).toBe(false);

    const strict = inspect(request, { strict: true });
    expect(strict.decision).toBe('block');
    expect(strict.reasonCode).toBe('inspection.incomplete');
  });

  it('detects cost actions through package, login-shell, and substitution wrappers', () => {
    const commands = [
      'npx wrangler deploy',
      'npm exec -- wrangler deploy',
      'pnpm dlx wrangler deploy',
      'yarn wrangler deploy',
      'bunx wrangler deploy',
      'bash -lc "terraform apply"',
      'echo "$(aws ec2 run-instances)"',
      'echo `aws s3 mb s3://demo`',
      'eval "terraform apply"',
    ];
    for (const command of commands) {
      expect(inspect(shellRequest(command)).decision, command).toBe('approval-required');
    }

    const argvDecision = inspect({
      source: 'cli',
      mode: 'interactive',
      action: {
        kind: 'shell',
        command: 'bash -lc terraform apply',
        argv: ['bash', '-lc', 'terraform apply'],
      },
    });
    expect(argvDecision.decision).toBe('approval-required');
  });

  it('does not let a flag value named help suppress a cost action', () => {
    const decision = inspect(shellRequest('aws --profile help ec2 run-instances'));
    expect(decision.decision).toBe('approval-required');
    expect(decision.reasonCode).toBe('aws.ec2.run-instances');
  });

  it('blocks dynamic eval in strict mode', () => {
    const decision = inspect(shellRequest('eval "$CLOUD_COMMAND"'), { strict: true });
    expect(decision.decision).toBe('block');
    expect(decision.reasonCode).toBe('inspection.incomplete');
  });

  it('supports complete Terraform JSON and does not treat changedText as added', () => {
    const jsonDecision = inspect({
      source: 'cli',
      mode: 'interactive',
      action: {
        kind: 'file-change',
        path: 'main.tf.json',
        addedText: JSON.stringify({ resource: { aws_instance: { web: { instance_type: 't3.micro' } } } }),
      },
    });
    expect(jsonDecision.decision).toBe('approval-required');

    const changedOnly = inspect({
      source: 'cli',
      mode: 'interactive',
      action: {
        kind: 'file-change',
        path: 'main.tf',
        changedText: 'resource "aws_instance" "existing" {}',
      },
    });
    expect(changedOnly.decision).toBe('allow');
    expect(changedOnly.inspection.complete).toBe(false);
  });

  it('extracts real added lines from apply_patch input', () => {
    const decision = inspect({
      source: 'cli',
      mode: 'interactive',
      action: {
        kind: 'tool',
        name: 'apply_patch',
        arguments: {
          patch: [
            '*** Begin Patch',
            '*** Update File: main.tf',
            '@@',
            '+resource "aws_s3_bucket" "logs" {}',
            '*** End Patch',
          ].join('\n'),
        },
      },
    });
    expect(decision.decision).toBe('approval-required');
    expect(decision.reasonCode).toBe('terraform.resource-added');
  });
});
