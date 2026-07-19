import { describe, expect, it } from 'vitest';
import { inspect } from '../src/core/classify.js';
import { buildApprovalMessage, formatHuman } from '../src/format/output.js';
import { shellRequest } from './helpers/fixtures.js';

const SAMPLES = [
  'aws ec2 run-instances --instance-type t3.small',
  'aws s3 mb s3://demo',
  'terraform apply saved.plan',
  'wrangler deploy',
  'kubectl scale deployment web --replicas=4',
  'AGENT_COST_GUARD_DISABLED=1 terraform apply',
  'aws ec2 describe-instances',
];

describe('deterministic output', () => {
  it('produces stable decision JSON for representative commands', () => {
    const decisions = SAMPLES.map((command) => ({
      command,
      decision: inspect(shellRequest(command)),
    }));
    expect(decisions).toMatchSnapshot();
  });

  it('produces a stable approval message', () => {
    const decision = inspect(shellRequest('aws ec2 run-instances --instance-type t3.small'));
    expect(decision.approval).toBeDefined();
    const message = buildApprovalMessage(decision.approval!);
    expect(message).toMatchInlineSnapshot(`
      "Cost confirmation required:
      Provider: AWS
      Resource: EC2 instance(s)
      Billing: recurring and usage-based
      Price: unknown because region, instance type, count, and runtime determine the cost"
    `);
  });

  it('produces stable human output for a block', () => {
    const decision = inspect(shellRequest('export AGENT_COST_GUARD=off'));
    expect(formatHuman(decision)).toContain('Decision: BLOCKED');
    expect(formatHuman(decision)).toContain('Reason code: guard.bypass');
  });

  it('is order-independent for the same input', () => {
    const a = inspect(shellRequest('terraform apply'));
    const b = inspect(shellRequest('terraform apply'));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
