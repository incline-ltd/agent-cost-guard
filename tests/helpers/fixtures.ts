import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Action, DecisionKind, ToolAction, FileChangeAction } from '../../src/core/types.js';

function loadJson<T>(relative: string): T {
  const url = new URL(`../../fixtures/${relative}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as T;
}

export interface Expectation {
  decision: DecisionKind;
  reasonCode?: string;
}

export interface ShellCase {
  name: string;
  group: string;
  command: string;
  expect: Expectation;
}

export interface ToolCase {
  name: string;
  group: string;
  action: ToolAction;
  expect: Expectation;
}

export interface FileChangeCase {
  name: string;
  group: string;
  action: FileChangeAction;
  expect: Expectation;
}

export interface RedactionCase {
  name: string;
  input: string;
  absent: string[];
  present: string[];
  unchanged?: boolean;
}

export interface RuleContractCase {
  ruleId: string;
  positive: Action;
  negative: Action;
  near: Action;
}

export interface AdapterExpect {
  empty?: boolean;
  permissionDecision?: 'ask' | 'deny';
  reasonIncludes?: string;
  exitCode: number;
}

export interface ClaudeAdapterCase {
  name: string;
  input?: Record<string, unknown>;
  rawInput?: string;
  strict?: boolean;
  expect: AdapterExpect;
}

export interface CopilotAdapterCase extends ClaudeAdapterCase {
  mode: 'interactive' | 'cloud';
}

export type CodexAdapterCase = ClaudeAdapterCase;

export interface CursorAdapterExpect {
  neutral?: boolean;
  permission?: 'deny';
  reasonIncludes?: string;
  exitCode: number;
}

export interface CursorAdapterCase {
  name: string;
  input?: Record<string, unknown>;
  rawInput?: string;
  strict?: boolean;
  expect: CursorAdapterExpect;
}

export const shellCases = (): ShellCase[] => loadJson<ShellCase[]>('shell-cases.json');
export const toolCases = (): ToolCase[] => loadJson<ToolCase[]>('tool-cases.json');
export const fileChangeCases = (): FileChangeCase[] =>
  loadJson<FileChangeCase[]>('file-change-cases.json');
export const redactionCases = (): RedactionCase[] =>
  loadJson<RedactionCase[]>('redaction-cases.json');
export const ruleContractCases = (): RuleContractCase[] =>
  loadJson<RuleContractCase[]>('rule-contract-cases.json');
export const claudeAdapterCases = (): ClaudeAdapterCase[] =>
  loadJson<ClaudeAdapterCase[]>('adapters/claude-code.json');
export const copilotAdapterCases = (): CopilotAdapterCase[] =>
  loadJson<CopilotAdapterCase[]>('adapters/copilot.json');
export const codexAdapterCases = (): CodexAdapterCase[] =>
  loadJson<CodexAdapterCase[]>('adapters/codex.json');
export const cursorAdapterCases = (): CursorAdapterCase[] =>
  loadJson<CursorAdapterCase[]>('adapters/cursor.json');

/** Every fixture name referenced by rules, so tests can verify they exist. */
export function allCaseNames(): Set<string> {
  const names = new Set<string>();
  for (const c of shellCases()) names.add(c.name);
  for (const c of toolCases()) names.add(c.name);
  for (const c of fileChangeCases()) names.add(c.name);
  return names;
}

/** Build a shell inspection request from a raw command string. */
export function shellRequest(command: string): { source: 'cli'; mode: 'interactive'; action: Action } {
  return { source: 'cli', mode: 'interactive', action: { kind: 'shell', command } };
}
