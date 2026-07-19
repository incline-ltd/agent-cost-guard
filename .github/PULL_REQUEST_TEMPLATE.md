## What changed

Describe the user-visible behavior and why the change is needed.

## Safety

- [ ] Inspection remains local and deterministic.
- [ ] Inspected commands and tools are never executed, evaluated, sourced, or expanded.
- [ ] Output, diagnostics, fixtures, and snapshots contain only redacted or fake data.
- [ ] An `allow` result never weakens the host agent's permission system.
- [ ] No telemetry, account, LLM, network, or automatic-approval path was added.

## Verification

- [ ] New rules include positive, negative, near-match, and redaction cases.
- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run smoke`
- [ ] README and integration examples match the real CLI behavior.
