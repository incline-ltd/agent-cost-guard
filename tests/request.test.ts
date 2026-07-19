import { describe, expect, it } from 'vitest';
import { parseInspectionRequest } from '../src/core/types.js';

describe('parseInspectionRequest', () => {
  it('accepts a valid generic request and preserves unknown tool arguments', () => {
    const value = {
      source: 'ci',
      mode: 'non-interactive',
      action: {
        kind: 'tool',
        name: 'provider_tool',
        arguments: { nested: { providerShape: true }, count: 2 },
      },
    };
    const parsed = parseInspectionRequest(value);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.request.action).toEqual(value.action);
  });

  it('accepts first-class and generic agent sources', () => {
    for (const source of ['codex', 'cursor', 'generic'] as const) {
      const parsed = parseInspectionRequest({
        source,
        mode: 'interactive',
        action: { kind: 'tool', name: 'read_resource', arguments: {} },
      });
      expect(parsed.ok).toBe(true);
    }
  });

  it('returns a safe validation failure without throwing', () => {
    expect(parseInspectionRequest({ source: 'ci', mode: 'interactive', action: [] })).toEqual({
      ok: false,
      error: 'inspection request action must be an object',
    });

    const unreadable = new Proxy({}, { get: () => { throw new Error('untrusted getter'); } });
    expect(parseInspectionRequest(unreadable)).toEqual({
      ok: false,
      error: 'inspection request could not be safely read',
    });
  });
});
