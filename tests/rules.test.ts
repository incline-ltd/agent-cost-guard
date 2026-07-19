import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspect } from '../src/core/classify.js';
import { clearRuleCache, loadRules } from '../src/core/rules.js';
import type { Action } from '../src/core/types.js';
import { redactEvidence } from '../src/redaction/redact.js';
import { allCaseNames, ruleContractCases } from './helpers/fixtures.js';

function writeRuleSet(value: unknown): string {
  clearRuleCache();
  const dir = mkdtempSync(join(tmpdir(), 'acg-rules-'));
  writeFileSync(join(dir, 'rules.json'), JSON.stringify(value));
  return `${dir}/`;
}

function validRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'test.valid-rule',
    version: '1',
    provider: 'fake-provider',
    category: 'fake-category',
    actionForm: 'shell',
    decision: 'approval-required',
    reasonCode: 'test.valid-rule',
    summary: 'Fake rule used only for loader validation.',
    priority: 1,
    match: { bin: ['fakectl'], path: ['create'] },
    approval: {
      provider: 'fake-provider',
      resource: 'fake resource',
      billing: 'unknown',
      price: 'unknown; this is a fake validation rule',
    },
    ...overrides,
  };
}

function inspectAction(action: Action) {
  return inspect({ source: 'cli', mode: 'interactive', action }, { rules: packagedRules });
}

function actionEvidence(action: Action): string {
  if (action.kind === 'shell') return action.command;
  if (action.kind === 'tool') return `${action.name} ${JSON.stringify(action.arguments)}`;
  return `${action.path}\n${action.addedText ?? action.changedText ?? ''}`;
}

const packagedRules = loadRules();
const contracts = ruleContractCases();

describe('rule integrity', () => {
  const rules = packagedRules;

  it('loads a non-empty rule set', () => {
    expect(rules.length).toBeGreaterThan(20);
  });

  it('has unique rule ids', () => {
    const ids = rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every approval-required rule has a complete approval block', () => {
    for (const rule of rules) {
      if (rule.decision === 'approval-required') {
        expect(rule.approval, rule.id).toBeDefined();
        expect(rule.approval?.provider).toBeTruthy();
        expect(rule.approval?.resource).toBeTruthy();
        expect(rule.approval?.price).toBeTruthy();
      }
    }
  });

  it('no allow rule exists (allow is the absence of a match)', () => {
    expect(rules.some((r) => r.decision === 'allow')).toBe(false);
  });

  it('block rules never carry an approval block', () => {
    for (const rule of rules) {
      if (rule.decision === 'block') expect(rule.approval).toBeUndefined();
    }
  });

  it('every fixture referenced by a rule exists', () => {
    const names = allCaseNames();
    for (const rule of rules) {
      for (const fixture of rule.fixtures ?? []) {
        expect(names.has(fixture), `${rule.id} references missing fixture "${fixture}"`).toBe(true);
      }
    }
  });

  it('rules are deterministically ordered by priority then id', () => {
    const sorted = [...rules].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    expect(rules.map((r) => r.id)).toEqual(sorted.map((r) => r.id));
  });

  it('the cost-guard-bypass rule has the highest priority and blocks', () => {
    const bypass = rules.find((r) => r.id === 'generic.cost-guard-bypass');
    expect(bypass?.decision).toBe('block');
    expect(bypass?.priority).toBe(Math.max(...rules.map((r) => r.priority)));
  });
});

describe('per-rule behavior contracts', () => {
  it('covers all 47 packaged rules exactly once', () => {
    const ruleIds = packagedRules.map((rule) => rule.id).sort();
    const contractIds = contracts.map((contract) => contract.ruleId).sort();
    expect(contracts).toHaveLength(47);
    expect(new Set(contractIds).size).toBe(contractIds.length);
    expect(contractIds).toEqual(ruleIds);
  });

  it.each(contracts)('$ruleId has an exact positive, negative, and near-match contract', (contract) => {
    const rule = packagedRules.find((candidate) => candidate.id === contract.ruleId);
    expect(rule, contract.ruleId).toBeDefined();

    const positive = inspectAction(contract.positive);
    const negative = inspectAction(contract.negative);
    const near = inspectAction(contract.near);

    expect(positive.matches.map((match) => match.ruleId)).toContain(contract.ruleId);
    expect(positive.decision).toBe(rule?.decision);
    expect(positive.reasonCode).toBe(rule?.reasonCode);
    expect(negative.matches.map((match) => match.ruleId)).not.toContain(contract.ruleId);
    expect(near.matches.map((match) => match.ruleId)).not.toContain(contract.ruleId);
  });

  it.each(contracts)('$ruleId redacts a fake credential from positive-case evidence', (contract) => {
    const fakeCredential = `fake_${contract.ruleId.replace(/[^a-z0-9]/gi, '_')}_credential`;
    const rawEvidence = `${actionEvidence(contract.positive)} --api-token=${fakeCredential}`;
    const redacted = redactEvidence(rawEvidence, 1_000);

    expect(redacted).not.toContain(fakeCredential);
    expect(redacted).toContain('--api-token=[REDACTED]');
  });
});

describe('rule loader validation', () => {
  it('rejects a malformed rule file', () => {
    const dir = writeRuleSet([{ id: 'x', decision: 'nope' }]);
    expect(() => loadRules(dir)).toThrow(/Invalid rule file/);
  });

  it('rejects an approval-required rule without an approval block', () => {
    const rule = validRule();
    delete rule.approval;
    expect(() => loadRules(writeRuleSet([rule]))).toThrow(/approval block/);
  });

  it('rejects rule-level allow and approvals on block rules', () => {
    expect(() => loadRules(writeRuleSet([validRule({ decision: 'allow' })]))).toThrow(
      /allow is the absence/,
    );
    expect(() => loadRules(writeRuleSet([validRule({ decision: 'block' })]))).toThrow(
      /must not include an approval/,
    );
  });

  it('requires a finite priority', () => {
    expect(() => loadRules(writeRuleSet([validRule({ priority: null })]))).toThrow(
      /priority must be a finite number/,
    );
  });

  it('validates matcher fields against the action form', () => {
    expect(() =>
      loadRules(writeRuleSet([validRule({ match: { toolNameRegex: 'create' } })])),
    ).toThrow(/shell matcher has unsupported field/);
    expect(() =>
      loadRules(
        writeRuleSet([
          validRule({ actionForm: 'tool', match: { bin: ['fakectl'] } }),
        ]),
      ),
    ).toThrow(/tool matcher has unsupported field/);
    expect(() =>
      loadRules(
        writeRuleSet([
          validRule({
            actionForm: 'file-change',
            match: { pathSuffix: ['.tf'], special: 'terraform-added-resource', bin: ['fakectl'] },
          }),
        ]),
      ),
    ).toThrow(/file-change matcher has unsupported field/);
  });

  it('rejects invalid special matchers and ignored special fields', () => {
    expect(() =>
      loadRules(writeRuleSet([validRule({ match: { special: 'unknown-special' } })])),
    ).toThrow(/invalid special/);
    expect(() =>
      loadRules(
        writeRuleSet([
          validRule({ match: { special: 'scale-up-flags', bin: ['kubectl'] } }),
        ]),
      ),
    ).toThrow(/cannot include ignored/);
    expect(() =>
      loadRules(
        writeRuleSet([
          validRule({
            actionForm: 'file-change',
            match: { pathSuffix: ['.tf'], special: 'unknown-special' },
          }),
        ]),
      ),
    ).toThrow(/invalid special/);
  });

  it('compiles tool regular expressions while loading', () => {
    expect(() =>
      loadRules(
        writeRuleSet([
          validRule({ actionForm: 'tool', match: { toolNameRegex: '[invalid' } }),
        ]),
      ),
    ).toThrow(/not a valid regular expression/);
  });

  it('rejects empty and no-op matchers', () => {
    expect(() => loadRules(writeRuleSet([validRule({ match: {} })]))).toThrow(
      /no effective predicate/,
    );
    expect(() =>
      loadRules(writeRuleSet([validRule({ match: { noneFlag: ['--dry-run'] } })])),
    ).toThrow(/no effective predicate/);
    expect(() =>
      loadRules(
        writeRuleSet([
          validRule({ actionForm: 'tool', match: { toolNameRegex: '' } }),
        ]),
      ),
    ).toThrow(/non-empty regular expression/);
    expect(() =>
      loadRules(
        writeRuleSet([
          validRule({ actionForm: 'file-change', match: { pathSuffix: ['.tf'] } }),
        ]),
      ),
    ).toThrow(/invalid special/);
  });

  it('rejects an empty rule set', () => {
    expect(() => loadRules(writeRuleSet([]))).toThrow(/rule set is empty/);
  });
});
