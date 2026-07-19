# AGENTS.md

## Scope

These rules apply to the whole `agent-cost-guard` repository.

## Product invariants

- Inspection is local and deterministic. Do not add an LLM, account, telemetry,
  or network dependency.
- Never execute, evaluate, source, or expand a command being inspected.
- Treat hook payloads and proposed tool arguments as untrusted data.
- Redact before output, diagnostics, snapshots, or logs.
- Core `allow` means only that no cost rule matched. Adapters must not weaken
  the host agent's permission system.
- Keep automatic approval impossible.
- Fixtures must contain fake credentials and fake cloud identifiers only.

## Engineering

- Keep one Node.js and TypeScript package. Do not create a monorepo.
- Prefer Node built-ins and small direct functions.
- Keep deterministic rules under `rules/` with stable IDs.
- Every new rule needs positive, negative, near-match, and redaction tests.
- Keep provider-specific parsing behind a normalized core request and decision
  contract.
- Do not broaden the tool into a general command-security scanner.

## Workflow

- Check `git status --short --branch` before editing.
- Preserve unrelated work.
- Run targeted tests, typecheck, lint, build, and `git diff --check` when those
  commands exist.
- Keep README examples aligned with real CLI behaviour.
- Never include real credentials, private paths, customer data, or private
  infrastructure details.
