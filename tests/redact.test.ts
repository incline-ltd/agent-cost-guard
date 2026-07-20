import { describe, expect, it } from 'vitest';
import { inspect } from '../src/core/classify.js';
import { redact, redactEvidence } from '../src/redaction/redact.js';
import { redactionCases, shellRequest } from './helpers/fixtures.js';

describe('redaction', () => {
  for (const testCase of redactionCases()) {
    it(testCase.name, () => {
      const output = redact(testCase.input);
      for (const secret of testCase.absent) {
        expect(output, `must remove: ${secret}`).not.toContain(secret);
      }
      for (const keep of testCase.present) {
        expect(output, `must keep: ${keep}`).toContain(keep);
      }
      if (testCase.unchanged) {
        expect(output).toBe(testCase.input);
      }
    });
  }

  it('is idempotent (redacting twice equals redacting once)', () => {
    for (const testCase of redactionCases()) {
      const once = redact(testCase.input);
      const twice = redact(once);
      expect(twice, testCase.name).toBe(once);
    }
  });

  it('never leaks a secret through the evidence path', () => {
    const evidence = redactEvidence(
      'aws rds create-db-instance --master-user-password Sup3rSecret --db-instance-class db.m5.large',
    );
    expect(evidence).not.toContain('Sup3rSecret');
    expect(evidence).toContain('[REDACTED]');
  });

  it('clamps long evidence to a bounded length', () => {
    const long = `aws s3 mb s3://${'a'.repeat(500)}`;
    const evidence = redactEvidence(long, 80);
    expect(evidence.length).toBeLessThanOrEqual(80);
  });

  it('leaves an empty string untouched', () => {
    expect(redact('')).toBe('');
  });

  it('redacts a Slack-shaped token without storing a token-shaped fixture', () => {
    const fakeSlackToken = ['xoxb', '1111111111', '2222222222', 'FAKEEXAMPLE'].join('-');
    const output = redact(`token ${fakeSlackToken}`);

    expect(output).not.toContain(fakeSlackToken);
    expect(output).toContain('[REDACTED:SLACK_TOKEN]');
  });

  it('redacts a Google-shaped key without storing a key-shaped fixture', () => {
    const fakeGoogleApiKey = ['AIza', 'TESTONLY', '0'.repeat(27)].join('');
    const output = redact(`https://example.googleapis.com?key=${fakeGoogleApiKey}`);

    expect(output).not.toContain(fakeGoogleApiKey);
    expect(output).toContain('[REDACTED:GOOGLE_API_KEY]');
  });

  it('fully redacts quoted multiword flag values', () => {
    const inputs = [
      'deploy --password "alpha bravo charlie" --region us-east-1',
      "deploy --api-token 'alpha bravo charlie' --region us-east-1",
      // Tokenized evidence no longer has quote boundaries. Redact through the
      // next flag rather than risk exposing the rest of the original value.
      'deploy --password alpha bravo charlie --region us-east-1',
    ];

    for (const input of inputs) {
      const output = redact(input);
      expect(output).not.toContain('alpha');
      expect(output).not.toContain('bravo');
      expect(output).not.toContain('charlie');
      expect(output).toContain('[REDACTED]');
      expect(output).toContain('--region us-east-1');
      expect(redact(output)).toBe(output);
    }
  });

  it('fully redacts quoted multiword assignment values', () => {
    const inputs = [
      'PASSWORD="alpha bravo charlie" deploy',
      "api_token: 'alpha bravo charlie'",
      'PASSWORD=alpha bravo charlie deploy',
      '{"password": "alpha bravo charlie", "region": "us-east-1"}',
    ];

    for (const input of inputs) {
      const output = redact(input);
      expect(output).not.toContain('alpha');
      expect(output).not.toContain('bravo');
      expect(output).not.toContain('charlie');
      expect(output).toContain('[REDACTED]');
      expect(redact(output)).toBe(output);
    }
  });
});

describe('evidence redaction across input forms', () => {
  const SECRET = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  it('redacts a secret embedded in a shell command', () => {
    const decision = inspect(
      shellRequest(`GITHUB_TOKEN=${SECRET} aws s3 mb s3://demo`),
    );
    expect(decision.decision).toBe('approval-required');
    const evidence = decision.matches.map((m) => m.redactedEvidence ?? '').join(' ');
    expect(evidence).not.toContain(SECRET);
  });

  it('does not leak a quoted multiword flag after tokenization removes quotes', () => {
    const decision = inspect(
      shellRequest(
        'aws rds create-db-instance --master-user-password "alpha bravo charlie" --db-instance-class db.m5.large',
      ),
    );
    const serialized = JSON.stringify(decision);
    expect(serialized).not.toContain('alpha');
    expect(serialized).not.toContain('bravo');
    expect(serialized).not.toContain('charlie');
    expect(serialized).toContain('[REDACTED]');
  });

  it('redacts a secret arriving through a structured Bash tool call', () => {
    const decision = inspect({
      source: 'claude-code',
      mode: 'interactive',
      action: {
        kind: 'tool',
        name: 'Bash',
        arguments: { command: `aws rds create-db-instance --master-user-password ${SECRET}` },
      },
    });
    const serialized = JSON.stringify(decision);
    expect(serialized).not.toContain(SECRET);
  });
});
