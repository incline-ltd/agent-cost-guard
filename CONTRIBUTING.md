# Contributing

Thanks for helping improve `agent-cost-guard`.

## Before opening a pull request

1. Open an issue for a new provider, decision category, or output-contract
   change.
2. Keep the change focused.
3. Add positive, negative, near-match, and redaction contract cases for every
   rule. Keep the rule-to-case mapping in `fixtures/rule-contract-cases.json`.
4. Use fake credentials and fake resource identifiers.
5. Run the documented typecheck, lint, test, build, and package smoke commands.
6. Update the README when public behaviour changes.

Rules should detect real command structure, not rely on one broad keyword.
Explain false-positive and false-negative tradeoffs in the pull request.

Do not add telemetry, remote calls, automatic approval, command execution, or
large dependencies without a clear design discussion.
