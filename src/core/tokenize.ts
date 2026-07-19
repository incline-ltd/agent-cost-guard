/**
 * A deterministic, execution-free shell tokenizer.
 *
 * It splits a command string into command segments and structured tokens so
 * rules can match on command structure instead of raw substrings. It never
 * runs a shell, never calls eval, never resolves variables, globs, command
 * substitutions, or aliases, and never reads any command output. Unknown or
 * ambiguous constructs degrade to plain tokens; they are never expanded.
 */

export interface ParsedCommand {
  /** Leading `NAME=value` environment assignments for this segment. */
  env: Record<string, string>;
  /** Executable base name (directory and wrapper prefixes stripped). */
  bin: string;
  /** Tokens after the executable, redirections removed. */
  argv: string[];
  /** Positional (non-flag) tokens in order, used for subcommand matching. */
  positionals: string[];
  /** Parsed flags: `--name value`, `--name=value`, or boolean `true`. */
  flags: Map<string, string | true>;
  /** Best-effort raw text of the segment, for redacted evidence only. */
  raw: string;
}

export interface ShellParseResult {
  commands: ParsedCommand[];
  complete: boolean;
  /** Stable issue codes. They never contain command text. */
  issues: string[];
}

type Token =
  | { type: 'word'; value: string }
  | { type: 'op'; value: string };

const CONTROL_OPS = new Set([';', ';;', '&&', '||', '|', '|&', '&', '\n']);
const REDIRECTION = /^(?:\d*>>?|>>|>|<<<|<<|<|&>>|&>|\d*>&\d*)$/;

/** Command prefixes that wrap another command; unwrap to reach the real bin. */
const WRAPPERS = new Set([
  'sudo',
  'doas',
  'command',
  'env',
  'nice',
  'nohup',
  'time',
  'setsid',
  'stdbuf',
  'ionice',
]);

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash']);
const DYNAMIC_EVAL_CHARS = ['$', '`', '*', '?', '{', '}', '[', ']'] as const;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface ScanResult {
  tokens: Token[];
  issues: string[];
}

/**
 * Scan a command string into words and control/redirection operators.
 * Handles single quotes, double quotes, backslash escaping, and `#` comments.
 * Nothing is expanded.
 */
function scan(input: string): ScanResult {
  const tokens: Token[] = [];
  const issues: string[] = [];
  let word = '';
  let hasWord = false;
  let i = 0;
  const n = input.length;
  let parenthesisDepth = 0;

  const flushWord = (): void => {
    if (hasWord) {
      tokens.push({ type: 'word', value: word });
      word = '';
      hasWord = false;
    }
  };

  while (i < n) {
    const ch = input[i] as string;

    if (ch === "'") {
      hasWord = true;
      i += 1;
      while (i < n && input[i] !== "'") {
        word += input[i];
        i += 1;
      }
      if (i >= n) {
        issues.push('shell.unclosed-single-quote');
      } else {
        i += 1;
      }
      continue;
    }

    if (ch === '"') {
      hasWord = true;
      i += 1;
      while (i < n && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < n) {
          const next = input[i + 1] as string;
          // In double quotes, backslash only escapes these; keep the rest.
          if (next === '"' || next === '\\' || next === '$' || next === '`') {
            word += next;
            i += 2;
            continue;
          }
        }
        word += input[i];
        i += 1;
      }
      if (i >= n) {
        issues.push('shell.unclosed-double-quote');
      } else {
        i += 1;
      }
      continue;
    }

    if (ch === '\\') {
      if (i + 1 < n) {
        const next = input[i + 1] as string;
        if (next === '\n') {
          i += 2; // line continuation
          continue;
        }
        word += next;
        hasWord = true;
        i += 2;
        continue;
      }
      issues.push('shell.trailing-backslash');
      i += 1;
      continue;
    }

    if (ch === '#' && !hasWord) {
      // Comment starts only at the beginning of a word; skip to end of line.
      while (i < n && input[i] !== '\n') i += 1;
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flushWord();
      i += 1;
      continue;
    }

    if (ch === '\n') {
      flushWord();
      tokens.push({ type: 'op', value: '\n' });
      i += 1;
      continue;
    }

    if (ch === '(' || ch === ')') {
      flushWord();
      tokens.push({ type: 'op', value: ch });
      if (ch === '(') {
        parenthesisDepth += 1;
      } else if (parenthesisDepth === 0) {
        issues.push('shell.unmatched-closing-parenthesis');
      } else {
        parenthesisDepth -= 1;
      }
      i += 1;
      continue;
    }

    if (ch === ';') {
      flushWord();
      if (input[i + 1] === ';') {
        tokens.push({ type: 'op', value: ';;' });
        i += 2;
      } else {
        tokens.push({ type: 'op', value: ';' });
        i += 1;
      }
      continue;
    }

    if (ch === '&') {
      flushWord();
      if (input[i + 1] === '&') {
        tokens.push({ type: 'op', value: '&&' });
        i += 2;
      } else if (input[i + 1] === '>') {
        const op = input[i + 2] === '>' ? '&>>' : '&>';
        tokens.push({ type: 'op', value: op });
        i += op.length;
      } else {
        tokens.push({ type: 'op', value: '&' });
        i += 1;
      }
      continue;
    }

    if (ch === '|') {
      flushWord();
      if (input[i + 1] === '|') {
        tokens.push({ type: 'op', value: '||' });
        i += 2;
      } else if (input[i + 1] === '&') {
        tokens.push({ type: 'op', value: '|&' });
        i += 2;
      } else {
        tokens.push({ type: 'op', value: '|' });
        i += 1;
      }
      continue;
    }

    if (ch === '>' || ch === '<') {
      flushWord();
      let op = ch;
      if (input[i + 1] === ch) op += ch; // >> or <<
      if (ch === '<' && input[i + 1] === '<' && input[i + 2] === '<') op = '<<<';
      tokens.push({ type: 'op', value: op });
      i += op.length;
      continue;
    }

    word += ch;
    hasWord = true;
    i += 1;
  }

  flushWord();
  if (parenthesisDepth > 0) issues.push('shell.unclosed-parenthesis');
  return { tokens, issues };
}

/** Group scanned tokens into per-command word lists split at control operators. */
function splitSegments(tokens: Token[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  let skipNextWord = false;

  const push = (): void => {
    if (current.length > 0) segments.push(current);
    current = [];
  };

  for (const token of tokens) {
    if (token.type === 'op') {
      if (CONTROL_OPS.has(token.value) || token.value === '(' || token.value === ')') {
        push();
        skipNextWord = false;
      } else if (REDIRECTION.test(token.value)) {
        // Drop the redirection and its following target word.
        skipNextWord = true;
      }
      continue;
    }
    if (skipNextWord) {
      skipNextWord = false;
      continue;
    }
    current.push(token.value);
  }
  push();
  return segments;
}

/** Parse a flat argv list into positionals and a flag map. */
function parseArgv(argv: string[]): {
  positionals: string[];
  flags: Map<string, string | true>;
} {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i] as string;
    if (tok.length > 1 && tok.startsWith('-') && tok !== '--') {
      const eq = tok.indexOf('=');
      if (eq !== -1) {
        flags.set(tok.slice(0, eq), tok.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags.set(tok, next);
        } else {
          flags.set(tok, true);
        }
      }
    } else if (tok !== '--') {
      positionals.push(tok);
    }
  }
  return { positionals, flags };
}

/** Strip a chain of leading wrapper commands (sudo, env, nice, ...). */
function unwrap(words: string[]): { env: Record<string, string>; rest: string[] } {
  const env: Record<string, string> = {};
  let rest = words.slice();

  // Consume leading environment assignments (FOO=bar cmd ...).
  while (rest.length > 0 && ASSIGNMENT.test(rest[0] as string)) {
    const assignment = rest[0] as string;
    const eq = assignment.indexOf('=');
    env[assignment.slice(0, eq)] = assignment.slice(eq + 1);
    rest = rest.slice(1);
  }

  let changed = true;
  while (changed && rest.length > 0) {
    changed = false;
    const head = baseName(rest[0] as string);
    if (WRAPPERS.has(head)) {
      rest = rest.slice(1);
      // env / sudo may carry their own flags and assignments.
      while (rest.length > 0) {
        const tok = rest[0] as string;
        if (ASSIGNMENT.test(tok)) {
          const eq = tok.indexOf('=');
          env[tok.slice(0, eq)] = tok.slice(eq + 1);
          rest = rest.slice(1);
          continue;
        }
        if (tok.startsWith('-')) {
          // Skip a flag; if it plausibly takes a value, skip that too.
          const takesValue = /^-(?:u|g|C|p)$/.test(tok) || tok === '--user';
          rest = rest.slice(1);
          if (takesValue && rest.length > 0 && !(rest[0] as string).startsWith('-')) {
            rest = rest.slice(1);
          }
          continue;
        }
        break;
      }
      changed = true;
    }
  }
  return { env, rest };
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

const RUNNER_VALUE_FLAGS = new Set([
  '-p',
  '--package',
  '--cache',
  '--userconfig',
  '--registry',
  '--cwd',
  '--dir',
]);

function stripRunnerFlags(words: string[]): string[] {
  let rest = words.slice();
  while (rest.length > 0) {
    const token = rest[0] as string;
    if (token === '--') {
      return rest.slice(1);
    }
    if (!token.startsWith('-')) return rest;
    rest = rest.slice(1);
    if (RUNNER_VALUE_FLAGS.has(token) && rest.length > 0) rest = rest.slice(1);
  }
  return rest;
}

/** Reach the executable invoked through common JavaScript package runners. */
function unwrapPackageRunner(words: string[]): string[] {
  if (words.length === 0) return words;
  const head = baseName(words[0] as string);

  if (head === 'npx' || head === 'bunx') {
    return stripRunnerFlags(words.slice(1));
  }

  if (head === 'npm' && ['exec', 'x'].includes(words[1] ?? '')) {
    return stripRunnerFlags(words.slice(2));
  }

  if (head === 'pnpm' && ['dlx', 'exec'].includes(words[1] ?? '')) {
    return stripRunnerFlags(words.slice(2));
  }

  if (head === 'yarn') {
    const subcommand = words[1];
    if (subcommand === 'dlx' || subcommand === 'exec') {
      return stripRunnerFlags(words.slice(2));
    }
    // `yarn <binary> ...` runs a project binary or script. Either form can
    // invoke the named cost-bearing executable, so inspect it structurally.
    if (subcommand !== undefined && !subcommand.startsWith('-')) return words.slice(1);
  }

  return words;
}

/** Build a ParsedCommand from a segment's word list. */
function buildCommand(words: string[], raw: string): ParsedCommand | null {
  if (words.length === 0) return null;
  const unwrapped = unwrap(words);
  const env = unwrapped.env;
  const rest = unwrapPackageRunner(unwrapped.rest);
  if (rest.length === 0) {
    // An env-only segment (e.g. `AGENT_COST_GUARD_DISABLED=1`) still needs to be
    // inspected so a bare guard-disable assignment is not silently dropped.
    if (Object.keys(env).length === 0) return null;
    return { env, bin: '', argv: [], positionals: [], flags: new Map(), raw };
  }
  const bin = baseName(rest[0] as string);
  const argv = rest.slice(1);
  const { positionals, flags } = parseArgv(argv);
  return { env, bin, argv, positionals, flags, raw };
}

function findBacktickEnd(input: string, start: number): number {
  for (let i = start; i < input.length; i += 1) {
    if (input[i] === '\\') {
      i += 1;
      continue;
    }
    if (input[i] === '`') return i;
  }
  return -1;
}

/** Find the closing parenthesis for a literal `$(` without expanding it. */
function findSubstitutionEnd(input: string, start: number): number {
  let quote: "'" | '"' | null = null;
  for (let i = start; i < input.length; i += 1) {
    const ch = input[i] as string;
    if (ch === '\\' && quote !== "'") {
      i += 1;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === '$' && input[i + 1] === '(') {
        const nestedEnd = findSubstitutionEnd(input, i + 2);
        if (nestedEnd === -1) return -1;
        i = nestedEnd;
      } else if (ch === '`') {
        const nestedEnd = findBacktickEnd(input, i + 1);
        if (nestedEnd === -1) return -1;
        i = nestedEnd;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '`') {
      const nestedEnd = findBacktickEnd(input, i + 1);
      if (nestedEnd === -1) return -1;
      i = nestedEnd;
      continue;
    }
    if (ch === '$' && input[i + 1] === '(') {
      const nestedEnd = findSubstitutionEnd(input, i + 2);
      if (nestedEnd === -1) return -1;
      i = nestedEnd;
      continue;
    }
    if (ch === ')') return i;
  }
  return -1;
}

interface SubstitutionResult {
  scripts: string[];
  issues: string[];
}

/** Collect active command substitutions, including those inside double quotes. */
function collectCommandSubstitutions(input: string): SubstitutionResult {
  const scripts: string[] = [];
  const issues: string[] = [];
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] as string;
    if (ch === '\\' && quote !== "'") {
      i += 1;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (ch === "'" && quote === null) {
      quote = "'";
      continue;
    }
    if (ch === '$' && input[i + 1] === '(') {
      const end = findSubstitutionEnd(input, i + 2);
      if (end === -1) {
        issues.push('shell.unclosed-command-substitution');
        break;
      }
      scripts.push(input.slice(i + 2, end));
      i = end;
      continue;
    }
    if (ch === '`') {
      const end = findBacktickEnd(input, i + 1);
      if (end === -1) {
        issues.push('shell.unclosed-backtick-substitution');
        break;
      }
      scripts.push(input.slice(i + 1, end));
      i = end;
    }
  }

  return { scripts, issues };
}

function shellScriptArgument(cmd: ParsedCommand): string | undefined {
  for (let i = 0; i < cmd.argv.length; i += 1) {
    const token = cmd.argv[i] as string;
    if (token === '-c' || token === '--command') return cmd.argv[i + 1];
    if (token.startsWith('--command=')) return token.slice('--command='.length);
    if (/^-[^-]*c[^-]*$/.test(token)) return cmd.argv[i + 1];
  }
  return undefined;
}

function appendParsed(target: ShellParseResult, nested: ShellParseResult): void {
  target.commands.push(...nested.commands);
  target.complete = target.complete && nested.complete;
  target.issues.push(...nested.issues);
}

/**
 * Parse shell text and report whether every supported lexical form was
 * inspectable. Nested scripts are read as inert text and recursively parsed;
 * no command, substitution, variable, alias, or glob is ever expanded.
 */
export function parseShell(command: string, depth = 0): ShellParseResult {
  if (depth > 3) {
    return { commands: [], complete: false, issues: ['shell.maximum-nesting-exceeded'] };
  }

  const scanned = scan(command);
  const result: ShellParseResult = {
    commands: [],
    complete: scanned.issues.length === 0,
    issues: scanned.issues.slice(),
  };

  for (const words of splitSegments(scanned.tokens)) {
    const raw = words.join(' ');
    const cmd = buildCommand(words, raw);
    if (!cmd) continue;
    result.commands.push(cmd);

    if (SHELLS.has(cmd.bin)) {
      const script = shellScriptArgument(cmd);
      if (script !== undefined) appendParsed(result, parseShell(script, depth + 1));
    }

    if (cmd.bin === 'eval' && cmd.argv.length > 0) {
      const script = cmd.argv.join(' ');
      appendParsed(result, parseShell(script, depth + 1));
      if (DYNAMIC_EVAL_CHARS.some((character) => script.includes(character))) {
        result.complete = false;
        result.issues.push('shell.dynamic-eval');
      }
    }
  }

  const substitutions = collectCommandSubstitutions(command);
  if (substitutions.issues.length > 0) {
    result.complete = false;
    result.issues.push(...substitutions.issues);
  }
  for (const script of substitutions.scripts) {
    appendParsed(result, parseShell(script, depth + 1));
  }

  result.issues = [...new Set(result.issues)];
  return result;
}

/** Compatibility helper returning only parsed command units. */
export function parseShellCommand(command: string, depth = 0): ParsedCommand[] {
  return parseShell(command, depth).commands;
}

/**
 * Build a ParsedCommand directly from a pre-tokenized argv (e.g. CLI `-- args`).
 * Treated as a single command with no shell operators.
 */
export function parseShellArgv(argv: string[]): ShellParseResult {
  const cmd = buildCommand(argv, argv.join(' '));
  const result: ShellParseResult = { commands: cmd ? [cmd] : [], complete: true, issues: [] };
  if (cmd && SHELLS.has(cmd.bin)) {
    const script = shellScriptArgument(cmd);
    if (script !== undefined) appendParsed(result, parseShell(script, 1));
  }
  if (cmd?.bin === 'eval' && cmd.argv.length > 0) {
    const script = cmd.argv.join(' ');
    appendParsed(result, parseShell(script, 1));
    if (DYNAMIC_EVAL_CHARS.some((character) => script.includes(character))) {
      result.complete = false;
      result.issues.push('shell.dynamic-eval');
    }
  }
  return result;
}

/** Compatibility helper returning only parsed argv command units. */
export function parseArgvCommand(argv: string[]): ParsedCommand[] {
  return parseShellArgv(argv).commands;
}

/** True when a rule's ordered token sequence appears contiguously in tokens. */
export function containsSequence(tokens: readonly string[], sequence: readonly string[]): boolean {
  if (sequence.length === 0) return true;
  if (sequence.length > tokens.length) return false;
  for (let i = 0; i + sequence.length <= tokens.length; i += 1) {
    let match = true;
    for (let j = 0; j < sequence.length; j += 1) {
      if (tokens[i + j] !== sequence[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}
