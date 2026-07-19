/**
 * Public API for agent-cost-guard.
 *
 * Everything here is local and deterministic. Nothing executes, spawns, or
 * reaches the network.
 */

export type {
  Action,
  Approval,
  Billing,
  Decision,
  DecisionKind,
  FileChangeAction,
  InspectionIssue,
  InspectionRequest,
  InspectionRequestParseResult,
  InspectionStatus,
  Match,
  Mode,
  ShellAction,
  Source,
  ToolAction,
} from './core/types.js';

export { parseInspectionRequest } from './core/types.js';

export { inspect, type InspectOptions } from './core/classify.js';
export {
  loadRules,
  defaultRulesDir,
  clearRuleCache,
  type Rule,
  type ActionForm,
} from './core/rules.js';
export {
  buildApprovalMessage,
  buildApprovalMessages,
  formatHuman,
  formatJson,
  reasonText,
} from './format/output.js';
export { redact, redactEvidence } from './redaction/redact.js';
