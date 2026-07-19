/**
 * Rule types plus a deterministic loader for the JSON rule files under
 * `rules/`. Rules are trusted local configuration, not untrusted input, but the
 * loader still validates shape so a malformed rule fails loudly at startup
 * rather than silently disabling a policy.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Billing, DecisionKind } from './types.js';

export type ActionForm = 'shell' | 'tool' | 'file-change';

export type ShellSpecial = 'cost-guard-bypass' | 'scale-up-flags';
export type FileChangeSpecial = 'terraform-added-resource';

export interface ShellMatcher {
  bin?: string[];
  /** Ordered token sequence that must appear contiguously in positionals. */
  path?: string[];
  /** Any of several ordered token sequences. */
  pathAny?: string[][];
  /** At least one of these flags must be present. */
  anyFlag?: string[];
  /** All of these flags must be present. */
  allFlags?: string[];
  /** None of these flags may be present. */
  noneFlag?: string[];
  /** Flag value must parse to a number >= the given threshold. */
  flagValueGte?: Record<string, number>;
  /** Any of these exact tokens must appear among positionals. */
  anyPositional?: string[];
  /** Both token sets must each have a member present among positionals. */
  positionalPair?: [string[], string[]];
  special?: ShellSpecial;
}

export interface ToolMatcher {
  toolNameRegex?: string;
  argKeyRegex?: string;
  argValueRegex?: string;
}

export interface FileChangeMatcher {
  pathSuffix?: string[];
  special?: FileChangeSpecial;
}

export type Matcher = ShellMatcher | ToolMatcher | FileChangeMatcher;

export interface RuleApproval {
  provider: string;
  resource: string;
  billing: Billing;
  price: string;
}

export interface Rule {
  id: string;
  version: string;
  provider: string;
  category: string;
  actionForm: ActionForm;
  decision: DecisionKind;
  reasonCode: string;
  summary: string;
  /** Higher priority wins when selecting the primary match for the message. */
  priority: number;
  match: Matcher;
  approval?: RuleApproval;
  fixtures?: string[];
}

const BILLING_VALUES: readonly Billing[] = [
  'one-time',
  'recurring',
  'usage-based',
  'mixed',
  'unknown',
];

const DECISIONS: readonly DecisionKind[] = ['allow', 'approval-required', 'block'];
const ACTION_FORMS: readonly ActionForm[] = ['shell', 'tool', 'file-change'];
const SHELL_SPECIALS: readonly ShellSpecial[] = ['cost-guard-bypass', 'scale-up-flags'];
const FILE_CHANGE_SPECIALS: readonly FileChangeSpecial[] = ['terraform-added-resource'];
const SHELL_MATCHER_KEYS = new Set([
  'bin',
  'path',
  'pathAny',
  'anyFlag',
  'allFlags',
  'noneFlag',
  'flagValueGte',
  'anyPositional',
  'positionalPair',
  'special',
]);
const TOOL_MATCHER_KEYS = new Set(['toolNameRegex', 'argKeyRegex', 'argValueRegex']);
const FILE_CHANGE_MATCHER_KEYS = new Set(['pathSuffix', 'special']);

function fail(file: string, message: string): never {
  throw new Error(`Invalid rule file ${file}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function assertKnownKeys(
  file: string,
  actionForm: ActionForm,
  matcher: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  for (const key of Object.keys(matcher)) {
    if (!allowed.has(key)) {
      fail(file, `${actionForm} matcher has unsupported field "${key}"`);
    }
  }
}

function assertStringArrayField(
  file: string,
  matcher: Record<string, unknown>,
  key: string,
): void {
  if (matcher[key] !== undefined && !isNonEmptyStringArray(matcher[key])) {
    fail(file, `matcher field "${key}" must be a non-empty array of non-empty strings`);
  }
}

function validateShellMatcher(file: string, matcher: Record<string, unknown>): void {
  assertKnownKeys(file, 'shell', matcher, SHELL_MATCHER_KEYS);

  for (const key of ['bin', 'path', 'anyFlag', 'allFlags', 'noneFlag', 'anyPositional']) {
    assertStringArrayField(file, matcher, key);
  }

  if (matcher.pathAny !== undefined) {
    if (
      !Array.isArray(matcher.pathAny) ||
      matcher.pathAny.length === 0 ||
      !matcher.pathAny.every(isNonEmptyStringArray)
    ) {
      fail(file, 'matcher field "pathAny" must contain non-empty token sequences');
    }
  }

  if (matcher.flagValueGte !== undefined) {
    if (!isRecord(matcher.flagValueGte) || Object.keys(matcher.flagValueGte).length === 0) {
      fail(file, 'matcher field "flagValueGte" must be a non-empty object');
    }
    for (const [flag, threshold] of Object.entries(matcher.flagValueGte)) {
      if (!isNonEmptyString(flag) || typeof threshold !== 'number' || !Number.isFinite(threshold)) {
        fail(file, 'matcher field "flagValueGte" must map non-empty flags to finite numbers');
      }
    }
  }

  if (matcher.positionalPair !== undefined) {
    if (
      !Array.isArray(matcher.positionalPair) ||
      matcher.positionalPair.length !== 2 ||
      !matcher.positionalPair.every(isNonEmptyStringArray)
    ) {
      fail(file, 'matcher field "positionalPair" must contain exactly two non-empty token sets');
    }
  }

  if (matcher.special !== undefined) {
    if (!SHELL_SPECIALS.includes(matcher.special as ShellSpecial)) {
      fail(file, `shell matcher has invalid special "${String(matcher.special)}"`);
    }
    if (Object.keys(matcher).length !== 1) {
      fail(file, 'shell special matchers cannot include ignored structural fields');
    }
    return;
  }

  // `allFlags` and `noneFlag` only narrow another predicate. On their own the
  // current matcher intentionally never matches, so accepting them would make
  // a silent no-op rule.
  const hasPositivePredicate = [
    'bin',
    'path',
    'pathAny',
    'anyFlag',
    'flagValueGte',
    'anyPositional',
    'positionalPair',
  ].some((key) => matcher[key] !== undefined);
  if (!hasPositivePredicate) fail(file, 'shell matcher has no effective predicate');
}

function validateToolMatcher(file: string, matcher: Record<string, unknown>): void {
  assertKnownKeys(file, 'tool', matcher, TOOL_MATCHER_KEYS);
  let count = 0;
  for (const key of TOOL_MATCHER_KEYS) {
    const pattern = matcher[key];
    if (pattern === undefined) continue;
    if (!isNonEmptyString(pattern)) {
      fail(file, `matcher field "${key}" must be a non-empty regular expression`);
    }
    try {
      new RegExp(pattern, 'i');
    } catch (error) {
      fail(file, `matcher field "${key}" is not a valid regular expression (${(error as Error).message})`);
    }
    count += 1;
  }
  if (count === 0) fail(file, 'tool matcher has no effective predicate');
}

function validateFileChangeMatcher(file: string, matcher: Record<string, unknown>): void {
  assertKnownKeys(file, 'file-change', matcher, FILE_CHANGE_MATCHER_KEYS);
  assertStringArrayField(file, matcher, 'pathSuffix');
  if (!FILE_CHANGE_SPECIALS.includes(matcher.special as FileChangeSpecial)) {
    fail(file, `file-change matcher has invalid special "${String(matcher.special)}"`);
  }
}

function validateMatcher(file: string, actionForm: ActionForm, value: unknown): void {
  if (!isRecord(value)) fail(file, 'missing match object');
  if (actionForm === 'shell') validateShellMatcher(file, value);
  else if (actionForm === 'tool') validateToolMatcher(file, value);
  else validateFileChangeMatcher(file, value);
}

function validateRule(file: string, raw: unknown): Rule {
  if (!isRecord(raw)) fail(file, 'rule is not an object');
  const r = raw;
  for (const key of ['id', 'version', 'provider', 'category', 'reasonCode', 'summary']) {
    if (!isNonEmptyString(r[key])) {
      fail(file, `missing string field "${key}"`);
    }
  }
  if (!ACTION_FORMS.includes(r.actionForm as ActionForm)) {
    fail(file, `invalid actionForm "${String(r.actionForm)}"`);
  }
  if (!DECISIONS.includes(r.decision as DecisionKind)) {
    fail(file, `invalid decision "${String(r.decision)}"`);
  }
  if (r.decision === 'allow') {
    fail(file, 'allow rules are invalid; allow is the absence of a rule match');
  }
  if (typeof r.priority !== 'number' || !Number.isFinite(r.priority)) {
    fail(file, 'priority must be a finite number');
  }
  validateMatcher(file, r.actionForm as ActionForm, r.match);

  if (r.approval !== undefined) {
    if (!isRecord(r.approval)) fail(file, 'approval must be an object');
    const a = r.approval;
    for (const key of ['provider', 'resource', 'price']) {
      if (!isNonEmptyString(a[key])) {
        fail(file, `approval missing string field "${key}"`);
      }
    }
    if (!BILLING_VALUES.includes(a.billing as Billing)) {
      fail(file, `approval has invalid billing "${String(a.billing)}"`);
    }
  }
  if (r.decision === 'approval-required' && r.approval === undefined) {
    fail(file, 'approval-required rules must include an approval block');
  }
  if (r.decision === 'block' && r.approval !== undefined) {
    fail(file, 'block rules must not include an approval block');
  }
  if (
    r.fixtures !== undefined &&
    (!Array.isArray(r.fixtures) || !r.fixtures.every(isNonEmptyString))
  ) {
    fail(file, 'fixtures must be an array of non-empty strings');
  }
  return r as unknown as Rule;
}

/** Resolve the packaged rules directory relative to this module. */
export function defaultRulesDir(): string {
  return fileURLToPath(new URL('../../rules/', import.meta.url));
}

let cache: { dir: string; rules: Rule[] } | null = null;

/**
 * Load and validate all rule files from a directory. Deterministic order:
 * by descending priority, then rule id. Result is cached per directory.
 */
export function loadRules(dir: string = defaultRulesDir()): Rule[] {
  if (cache && cache.dir === dir) return cache.rules;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const rules: Rule[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const contents = readFileSync(join(dir, file), 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      fail(file, `not valid JSON (${(error as Error).message})`);
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of list) {
      const rule = validateRule(file, entry);
      if (seen.has(rule.id)) fail(file, `duplicate rule id "${rule.id}"`);
      seen.add(rule.id);
      rules.push(rule);
    }
  }
  if (rules.length === 0) fail(dir, 'rule set is empty');
  rules.sort((a, b) => (b.priority - a.priority) || a.id.localeCompare(b.id));
  cache = { dir, rules };
  return rules;
}

/** Clear the rules cache (used by tests that load fixture rule sets). */
export function clearRuleCache(): void {
  cache = null;
}
