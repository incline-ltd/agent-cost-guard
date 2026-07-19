/**
 * Shared contracts for agent-cost-guard.
 *
 * These types are the stable seam between provider-specific parsing and the
 * deterministic decision engine. Nothing here executes, spawns, or resolves a
 * command; every value is treated as untrusted data.
 */

const SOURCES = [
  'cli',
  'claude-code',
  'codex',
  'cursor',
  'github-copilot',
  'ci',
  'generic',
] as const;

export type Source = (typeof SOURCES)[number];

export type Mode = 'interactive' | 'non-interactive';

/** A raw shell command, optionally pre-split into argv by the caller. */
export interface ShellAction {
  kind: 'shell';
  /** Raw command text. Never executed or expanded. */
  command: string;
  /**
   * Pre-tokenized argv, when the caller already has it (e.g. CLI `-- args`).
   * When present it is trusted as a single command with no shell operators.
   */
  argv?: string[];
}

/** A structured tool call: a tool name plus JSON arguments. */
export interface ToolAction {
  kind: 'tool';
  name: string;
  arguments: Record<string, unknown>;
}

/** A proposed file change, used for Terraform added-text inspection. */
export interface FileChangeAction {
  kind: 'file-change';
  path: string;
  /** Text being added (added diff lines / new file content / inserted text). */
  addedText?: string;
  /** Full changed text, when the caller cannot separate added from removed. */
  changedText?: string;
}

export type Action = ShellAction | ToolAction | FileChangeAction;

export interface InspectionRequest {
  source: Source;
  mode: Mode;
  action: Action;
}

export type InspectionRequestParseResult =
  | { ok: true; request: InspectionRequest }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate the generic JSON inspection contract without throwing.
 *
 * Tool arguments deliberately remain unknown, untrusted values. The parser
 * validates only the outer record so adapters and matchers can inspect keys
 * without assuming anything about provider-specific argument shapes.
 */
function parseInspectionRequestValue(value: unknown): InspectionRequestParseResult {
  if (!isRecord(value)) return { ok: false, error: 'inspection request must be an object' };

  const source = value.source;
  if (!SOURCES.includes(source as Source)) {
    return { ok: false, error: 'inspection request has an invalid source' };
  }

  const mode = value.mode;
  if (mode !== 'interactive' && mode !== 'non-interactive') {
    return { ok: false, error: 'inspection request has an invalid mode' };
  }

  const rawAction = value.action;
  if (!isRecord(rawAction)) return { ok: false, error: 'inspection request action must be an object' };

  let action: Action;
  switch (rawAction.kind) {
    case 'shell': {
      if (typeof rawAction.command !== 'string') {
        return { ok: false, error: 'shell action requires a string command' };
      }
      if (
        rawAction.argv !== undefined &&
        (!Array.isArray(rawAction.argv) || !rawAction.argv.every((item) => typeof item === 'string'))
      ) {
        return { ok: false, error: 'shell action argv must be an array of strings' };
      }
      action = {
        kind: 'shell',
        command: rawAction.command,
        ...(rawAction.argv === undefined ? {} : { argv: rawAction.argv as string[] }),
      };
      break;
    }
    case 'tool':
      if (typeof rawAction.name !== 'string' || rawAction.name.length === 0) {
        return { ok: false, error: 'tool action requires a non-empty string name' };
      }
      if (!isRecord(rawAction.arguments)) {
        return { ok: false, error: 'tool action arguments must be an object' };
      }
      action = { kind: 'tool', name: rawAction.name, arguments: rawAction.arguments };
      break;
    case 'file-change':
      if (typeof rawAction.path !== 'string' || rawAction.path.length === 0) {
        return { ok: false, error: 'file-change action requires a non-empty string path' };
      }
      if (rawAction.addedText !== undefined && typeof rawAction.addedText !== 'string') {
        return { ok: false, error: 'file-change addedText must be a string' };
      }
      if (rawAction.changedText !== undefined && typeof rawAction.changedText !== 'string') {
        return { ok: false, error: 'file-change changedText must be a string' };
      }
      action = {
        kind: 'file-change',
        path: rawAction.path,
        ...(rawAction.addedText === undefined ? {} : { addedText: rawAction.addedText }),
        ...(rawAction.changedText === undefined ? {} : { changedText: rawAction.changedText }),
      };
      break;
    default:
      return { ok: false, error: 'inspection request action has an invalid kind' };
  }

  return {
    ok: true,
    request: { source: source as Source, mode, action },
  };
}

export function parseInspectionRequest(value: unknown): InspectionRequestParseResult {
  try {
    return parseInspectionRequestValue(value);
  } catch {
    return { ok: false, error: 'inspection request could not be safely read' };
  }
}

export type DecisionKind = 'allow' | 'approval-required' | 'block';

export type Billing =
  | 'one-time'
  | 'recurring'
  | 'usage-based'
  | 'mixed'
  | 'unknown';

export interface Approval {
  provider: string;
  resource: string;
  billing: Billing;
  price: string;
}

export interface Match {
  ruleId: string;
  category: string;
  redactedEvidence?: string;
}

export interface InspectionIssue {
  /** Stable machine-readable identifier. Never contains untrusted input. */
  code: string;
  /** Safe human-readable explanation. Never contains untrusted input. */
  message: string;
}

export interface InspectionStatus {
  /** False when some relevant part of the proposed action was not inspectable. */
  complete: boolean;
  issues: InspectionIssue[];
}

export interface Decision {
  version: '1';
  decision: DecisionKind;
  reasonCode: string;
  summary: string;
  inspection: InspectionStatus;
  /** All distinct approvals in deterministic priority order. */
  approvals?: Approval[];
  /** First approval retained for backwards compatibility. */
  approval?: Approval;
  matches: Match[];
}
