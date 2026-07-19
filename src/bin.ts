#!/usr/bin/env node
/** Executable entrypoint. Keep CLI argument handling importable and testable. */

import process from 'node:process';
import { setTimeout } from 'node:timers';
import { main } from './cli.js';
import { redact } from './redaction/redact.js';

try {
  const args = process.argv.slice(2);
  const exitCode = main(args);
  process.exitCode = exitCode;

  // Cursor 3.10 has a confirmed host-side race that can drop stdout from
  // fast-exiting hooks. Cursor recommends a brief grace period while its fix
  // is pending. This affects only the executable adapter, never inspection.
  // https://forum.cursor.com/t/race-condition-silently-disables-hooks-that-exit-quickly/165818/7
  if (exitCode === 0 && args[0] === 'hook' && args[1] === 'cursor') {
    setTimeout(() => undefined, 60);
  }
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agent-cost-guard: ${redact(message)}\n`);
  process.exitCode = 1;
}
