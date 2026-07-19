/**
 * Deterministic matchers for the three action forms. Each returns whether a
 * rule matched and, when it did, the raw evidence substring. Callers redact
 * evidence before it appears in any output.
 *
 * Matchers only read structure. They never execute, expand, or resolve
 * anything.
 */

import { containsSequence, type ParsedCommand } from './tokenize.js';
import type {
  FileChangeMatcher,
  Rule,
  ShellMatcher,
  ToolMatcher,
} from './rules.js';
import type { FileChangeAction, ToolAction } from './types.js';

export interface MatchResult {
  matched: boolean;
  evidence?: string;
}

const NO_MATCH: MatchResult = { matched: false };

/** Segments that never carry a cost action; treated as no-ops. */
const NOOP_BINS = new Set([
  'echo',
  'printf',
  'true',
  'false',
  ':',
  'cat',
  'ls',
  'cd',
  'pwd',
  'which',
  'type',
  'man',
  'help',
]);

const HELP_FLAGS = new Set(['--help', '-h', '--version', '-help']);

/** Generic scaling flags that clearly increase paid capacity when raised. */
const SCALE_FLAGS = [
  '--replicas',
  '--desired-capacity',
  '--max-capacity',
  '--min-instances',
  '--max-instances',
  '--node-count',
  '--num-nodes',
  '--max-nodes',
];

/** True when a segment is documentation/no-op and should not cost-match. */
export function isInertCommand(cmd: ParsedCommand): boolean {
  if (NOOP_BINS.has(cmd.bin)) return true;
  for (const flag of cmd.flags.keys()) {
    if (HELP_FLAGS.has(flag)) return true;
  }
  // `aws help`, `terraform help`, `wrangler help`. Only the leading argv token
  // counts: a flag value named "help" must not hide a later cost subcommand.
  if (cmd.argv[0] === 'help') return true;
  return false;
}

function flagValue(cmd: ParsedCommand, name: string): string | true | undefined {
  return cmd.flags.get(name);
}

function numericFlagAtLeast(cmd: ParsedCommand, name: string, threshold: number): boolean {
  const value = flagValue(cmd, name);
  if (typeof value !== 'string') return false;
  const n = Number(value);
  return Number.isFinite(n) && n >= threshold;
}

function truthyDisableValue(value: string): boolean {
  return ['1', 'true', 'yes', 'on', 'enable', 'enabled', 'skip', 'bypass', 'disable', 'disabled'].includes(
    value.toLowerCase(),
  );
}

function falsyValue(value: string): boolean {
  return ['0', 'false', 'no', 'off', 'disable', 'disabled', 'none'].includes(value.toLowerCase());
}

/** Detect an attempt to disable, bypass, or turn off the active cost guard. */
function matchCostGuardBypass(cmd: ParsedCommand): MatchResult {
  const assignments: Array<[string, string]> = Object.entries(cmd.env);
  if (['export', 'set', 'setenv', 'declare'].includes(cmd.bin)) {
    for (const tok of cmd.argv) {
      const eq = tok.indexOf('=');
      if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(tok.slice(0, eq))) {
        assignments.push([tok.slice(0, eq), tok.slice(eq + 1)]);
      }
    }
  }
  for (const [name, value] of assignments) {
    if (!/AGENT_COST_GUARD|(^|_)ACG_/i.test(name)) continue;
    const upper = name.toUpperCase();
    if (/DISABLE|BYPASS|SKIP|OFF/.test(upper) && truthyDisableValue(value)) {
      return { matched: true, evidence: `${name}=${value}` };
    }
    if (/ENABLE|ENABLED|ACTIVE|ON/.test(upper) && falsyValue(value)) {
      return { matched: true, evidence: `${name}=${value}` };
    }
    if (upper === 'AGENT_COST_GUARD' && falsyValue(value)) {
      return { matched: true, evidence: `${name}=${value}` };
    }
  }
  // Disabling flags on the guard binary itself.
  if (cmd.bin === 'agent-cost-guard') {
    for (const flag of ['--disable', '--no-guard', '--bypass', '--off']) {
      if (cmd.flags.has(flag)) return { matched: true, evidence: `agent-cost-guard ${flag}` };
    }
  }
  return NO_MATCH;
}

/** Detect a clear scale-up: replicas / capacity raised to two or more. */
function matchScaleUp(cmd: ParsedCommand): MatchResult {
  // kubectl scale --replicas=N
  if (cmd.bin === 'kubectl' && cmd.positionals.includes('scale')) {
    if (numericFlagAtLeast(cmd, '--replicas', 2)) {
      return { matched: true, evidence: `kubectl scale --replicas=${String(cmd.flags.get('--replicas'))}` };
    }
  }
  // docker service scale name=N  /  docker service update --replicas N
  if (cmd.bin === 'docker' && cmd.positionals.includes('service')) {
    if (numericFlagAtLeast(cmd, '--replicas', 2)) {
      return { matched: true, evidence: `docker service --replicas=${String(cmd.flags.get('--replicas'))}` };
    }
    for (const tok of cmd.positionals) {
      const eq = tok.indexOf('=');
      if (eq > 0) {
        const n = Number(tok.slice(eq + 1));
        if (Number.isFinite(n) && n >= 2) return { matched: true, evidence: `docker service scale ${tok}` };
      }
    }
  }
  // Generic infra scaling flags on any tool.
  for (const flag of SCALE_FLAGS) {
    if (numericFlagAtLeast(cmd, flag, 2)) {
      return { matched: true, evidence: `${cmd.bin} ${flag}=${String(cmd.flags.get(flag))}` };
    }
  }
  return NO_MATCH;
}

/** Evaluate a shell rule against one parsed command. */
export function matchShell(rule: Rule, cmd: ParsedCommand): MatchResult {
  const m = rule.match as ShellMatcher;

  if (m.special === 'cost-guard-bypass') return matchCostGuardBypass(cmd);

  // Inert commands (echo, --help, ...) never carry cost, except bypass checks
  // above which must still fire (e.g. `agent-cost-guard --disable`).
  if (isInertCommand(cmd)) return NO_MATCH;

  if (m.special === 'scale-up-flags') return matchScaleUp(cmd);

  if (m.bin && !m.bin.includes(cmd.bin)) return NO_MATCH;

  if (m.path && !containsSequence(cmd.positionals, m.path)) return NO_MATCH;

  if (m.pathAny && !m.pathAny.some((seq) => containsSequence(cmd.positionals, seq))) {
    return NO_MATCH;
  }

  if (m.anyFlag && !m.anyFlag.some((flag) => cmd.flags.has(flag))) return NO_MATCH;

  if (m.allFlags && !m.allFlags.every((flag) => cmd.flags.has(flag))) return NO_MATCH;

  if (m.noneFlag && m.noneFlag.some((flag) => cmd.flags.has(flag))) return NO_MATCH;

  if (m.flagValueGte) {
    for (const [flag, threshold] of Object.entries(m.flagValueGte)) {
      if (!numericFlagAtLeast(cmd, flag, threshold)) return NO_MATCH;
    }
  }

  if (m.anyPositional && !m.anyPositional.some((tok) => cmd.positionals.includes(tok))) {
    return NO_MATCH;
  }

  if (m.positionalPair) {
    const [a, b] = m.positionalPair;
    const hasA = a.some((tok) => cmd.positionals.includes(tok));
    const hasB = b.some((tok) => cmd.positionals.includes(tok));
    if (!hasA || !hasB) return NO_MATCH;
  }

  // A rule with no structural predicate never matches (guards against typos).
  const hasPredicate =
    m.bin || m.path || m.pathAny || m.anyFlag || m.allFlags || m.flagValueGte || m.anyPositional || m.positionalPair;
  if (!hasPredicate) return NO_MATCH;

  return { matched: true, evidence: cmd.raw };
}

/** Evaluate a tool-name rule against a structured tool action. */
export function matchTool(rule: Rule, action: ToolAction): MatchResult {
  const m = rule.match as ToolMatcher;
  if (m.toolNameRegex) {
    const re = new RegExp(m.toolNameRegex, 'i');
    if (!re.test(action.name)) return NO_MATCH;
  }
  if (m.argKeyRegex) {
    const re = new RegExp(m.argKeyRegex, 'i');
    if (!Object.keys(action.arguments).some((key) => re.test(key))) return NO_MATCH;
  }
  if (m.argValueRegex) {
    const re = new RegExp(m.argValueRegex, 'i');
    const hit = Object.values(action.arguments).some(
      (value) => typeof value === 'string' && re.test(value),
    );
    if (!hit) return NO_MATCH;
  }
  if (!m.toolNameRegex && !m.argKeyRegex && !m.argValueRegex) return NO_MATCH;
  return { matched: true, evidence: action.name };
}

/**
 * Detect an added Terraform `resource` block in added text. Line and block
 * comments are ignored, and removed lines never reach this function because
 * callers pass only added text.
 */
export function detectAddedResourceBlock(addedText: string): string | null {
  const lines = addedText.split(/\r?\n/);
  let inBlockComment = false;
  const resource = /^\s*resource\s+"([^"]+)"\s+"([^"]+)"\s*\{?/;

  for (const original of lines) {
    let line = original;

    if (inBlockComment) {
      const close = line.indexOf('*/');
      if (close === -1) continue;
      line = line.slice(close + 2);
      inBlockComment = false;
    }

    // Strip a block comment that opens (and maybe closes) on this line.
    for (;;) {
      const open = line.indexOf('/*');
      if (open === -1) break;
      const close = line.indexOf('*/', open + 2);
      if (close === -1) {
        line = line.slice(0, open);
        inBlockComment = true;
        break;
      }
      line = line.slice(0, open) + ' ' + line.slice(close + 2);
    }

    // Strip line comments.
    const hash = line.indexOf('#');
    if (hash !== -1) line = line.slice(0, hash);
    const slashes = line.indexOf('//');
    if (slashes !== -1) line = line.slice(0, slashes);

    const match = resource.exec(line);
    if (match) return `resource "${match[1]}" "${match[2]}"`;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Detect a resource entry in a complete Terraform JSON document. */
export function detectAddedJsonResource(addedText: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(addedText) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.resource)) return null;

  for (const type of Object.keys(parsed.resource).sort()) {
    const namedResources = parsed.resource[type];
    if (!isRecord(namedResources)) continue;
    const name = Object.keys(namedResources).sort()[0];
    if (name !== undefined) return `resource "${type}" "${name}"`;
  }
  return null;
}

/** Evaluate a file-change rule against a proposed file change. */
export function matchFileChange(rule: Rule, action: FileChangeAction): MatchResult {
  const m = rule.match as FileChangeMatcher;
  if (m.pathSuffix && !m.pathSuffix.some((suffix) => action.path.endsWith(suffix))) {
    return NO_MATCH;
  }
  if (m.special === 'terraform-added-resource') {
    const text = action.addedText;
    if (text === undefined) return NO_MATCH;
    const evidence = action.path.toLowerCase().endsWith('.tf.json')
      ? detectAddedJsonResource(text)
      : detectAddedResourceBlock(text);
    return evidence ? { matched: true, evidence } : NO_MATCH;
  }
  return NO_MATCH;
}
