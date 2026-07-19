/**
 * The decision engine.
 *
 * Given a normalized inspection request, it evaluates every enabled rule
 * against every inspectable unit and returns one deterministic decision.
 * Severity order is block > approval-required > allow. `allow` means only that
 * no cost rule matched; it is never a general security approval and callers
 * must never treat it as automatic tool approval.
 */

import { matchFileChange, matchShell, matchTool } from './match.js';
import { normalize } from './normalize.js';
import { loadRules, type Rule } from './rules.js';
import type { Approval, Decision, InspectionRequest, Match } from './types.js';
import { redactEvidence } from '../redaction/redact.js';

export interface InspectOptions {
  /** Explicit rule set; defaults to the packaged rules. */
  rules?: Rule[];
  /** Block when a relevant part of the action cannot be fully inspected. */
  strict?: boolean;
}

interface RawMatch {
  rule: Rule;
  evidence?: string;
}

const ALLOW_SUMMARY =
  'No cost-bearing action matched this cost policy. This is not a general security approval.';
const INCOMPLETE_SUMMARY =
  'Blocked: the proposed action could not be completely inspected in strict mode.';

const SEVERITY = { block: 2, 'approval-required': 1, allow: 0 } as const;

function evaluate(units: ReturnType<typeof normalize>['units'], rules: Rule[]): RawMatch[] {
  const found: RawMatch[] = [];

  for (const unit of units) {
    for (const rule of rules) {
      let result;
      if (unit.kind === 'shell' && rule.actionForm === 'shell') {
        result = matchShell(rule, unit.cmd);
      } else if (unit.kind === 'tool' && rule.actionForm === 'tool') {
        result = matchTool(rule, unit.action);
      } else if (unit.kind === 'file-change' && rule.actionForm === 'file-change') {
        result = matchFileChange(rule, unit.action);
      } else {
        continue;
      }
      if (result.matched) {
        found.push(result.evidence === undefined ? { rule } : { rule, evidence: result.evidence });
      }
    }
  }
  return found.sort(
    (a, b) =>
      SEVERITY[b.rule.decision] - SEVERITY[a.rule.decision] ||
      b.rule.priority - a.rule.priority ||
      a.rule.id.localeCompare(b.rule.id),
  );
}

/** Deduplicate matches by rule id, preserving first (highest-priority) order. */
function toMatches(raw: RawMatch[]): Match[] {
  const seen = new Set<string>();
  const matches: Match[] = [];
  for (const { rule, evidence } of raw) {
    if (seen.has(rule.id)) continue;
    seen.add(rule.id);
    const entry: Match = { ruleId: rule.id, category: rule.category };
    if (evidence !== undefined) entry.redactedEvidence = redactEvidence(evidence);
    matches.push(entry);
  }
  return matches;
}

function toApprovals(raw: RawMatch[]): Approval[] {
  const approvals: Approval[] = [];
  const seen = new Set<string>();
  for (const { rule } of raw) {
    if (!rule.approval) continue;
    const approval: Approval = {
      provider: rule.approval.provider,
      resource: rule.approval.resource,
      billing: rule.approval.billing,
      price: rule.approval.price,
    };
    const key = JSON.stringify(approval);
    if (seen.has(key)) continue;
    seen.add(key);
    approvals.push(approval);
  }
  return approvals;
}

/** Inspect a request and return a single deterministic decision. */
export function inspect(request: InspectionRequest, options: InspectOptions = {}): Decision {
  const rules = options.rules ?? loadRules();
  const normalized = normalize(request.action);
  const inspection = { complete: normalized.complete, issues: normalized.issues };
  const raw = evaluate(normalized.units, rules);

  const blocks = raw.filter((m) => m.rule.decision === 'block');
  const approvals = raw.filter((m) => m.rule.decision === 'approval-required');

  if (blocks.length > 0) {
    const primary = (blocks[0] as RawMatch).rule;
    return {
      version: '1',
      decision: 'block',
      reasonCode: primary.reasonCode,
      summary: primary.summary,
      inspection,
      matches: toMatches(blocks),
    };
  }

  if (options.strict && !normalized.complete) {
    return {
      version: '1',
      decision: 'block',
      reasonCode: 'inspection.incomplete',
      summary: INCOMPLETE_SUMMARY,
      inspection,
      matches: toMatches(approvals),
    };
  }

  if (approvals.length > 0) {
    const primary = (approvals[0] as RawMatch).rule;
    const distinctApprovals = toApprovals(approvals);
    const decision: Decision = {
      version: '1',
      decision: 'approval-required',
      reasonCode: primary.reasonCode,
      summary: primary.summary,
      inspection,
      approvals: distinctApprovals,
      matches: toMatches(approvals),
    };
    if (distinctApprovals[0]) decision.approval = distinctApprovals[0];
    return decision;
  }

  return {
    version: '1',
    decision: 'allow',
    reasonCode: 'cost.no-match',
    summary: ALLOW_SUMMARY,
    inspection,
    matches: [],
  };
}
