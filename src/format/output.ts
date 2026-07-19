/**
 * Human and machine rendering of a decision.
 *
 * The approval message is the exact contract other tools depend on: it always
 * starts with `Cost confirmation required:` and lists provider, resource,
 * billing model, and price or a stated reason the price is unknown. Values come
 * from rule configuration, never from unredacted user input.
 */

import type { Approval, Billing, Decision } from '../core/types.js';

const BILLING_PHRASE: Record<Billing, string> = {
  'one-time': 'one-time',
  recurring: 'recurring',
  'usage-based': 'usage-based',
  mixed: 'recurring and usage-based',
  unknown: 'unknown',
};

/** Build the exact `Cost confirmation required:` approval message. */
export function buildApprovalMessage(approval: Approval): string {
  return [
    'Cost confirmation required:',
    `Provider: ${approval.provider}`,
    `Resource: ${approval.resource}`,
    `Billing: ${BILLING_PHRASE[approval.billing]}`,
    `Price: ${approval.price}`,
  ].join('\n');
}

/** Build one complete approval block per distinct cost-bearing action. */
export function buildApprovalMessages(approvals: readonly Approval[]): string {
  return approvals.map(buildApprovalMessage).join('\n\n');
}

function decisionApprovals(decision: Decision): Approval[] {
  if (decision.approvals && decision.approvals.length > 0) return decision.approvals;
  return decision.approval ? [decision.approval] : [];
}

/** The reason string an adapter passes to its host as the decision reason. */
export function reasonText(decision: Decision): string {
  const approvals = decisionApprovals(decision);
  if (approvals.length > 0) return buildApprovalMessages(approvals);
  return decision.summary;
}

/** Pretty JSON for `--json` output and snapshots. */
export function formatJson(decision: Decision): string {
  return JSON.stringify(decision, null, 2);
}

/** Human-readable terminal output for the generic CLI. */
export function formatHuman(decision: Decision): string {
  const label =
    decision.decision === 'allow'
      ? 'ALLOW'
      : decision.decision === 'approval-required'
        ? 'APPROVAL REQUIRED'
        : 'BLOCKED';
  const lines: string[] = ['Agent Cost Guard', `Decision: ${label}`, '', 'Reason:'];

  const approvals = decisionApprovals(decision);
  if (decision.decision === 'approval-required' && approvals.length > 0) {
    lines.push(buildApprovalMessages(approvals));
  } else {
    lines.push(decision.summary);
  }

  lines.push('', `Reason code: ${decision.reasonCode}`);

  if (!decision.inspection.complete) {
    lines.push('Inspection: INCOMPLETE');
    for (const issue of decision.inspection.issues) {
      lines.push(`  - ${issue.code}: ${issue.message}`);
    }
  }

  if (decision.matches.length > 0) {
    lines.push('Matched rules:');
    for (const match of decision.matches) {
      const evidence = match.redactedEvidence ? ` (${match.redactedEvidence})` : '';
      lines.push(`  - ${match.ruleId}${evidence}`);
    }
  }

  return lines.join('\n');
}
