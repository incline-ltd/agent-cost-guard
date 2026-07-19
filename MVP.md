# MVP implementation contract

## Outcome

Build a local TypeScript CLI that inspects a proposed agent action without
executing it and returns one deterministic cost-policy decision:

- `allow`
- `approval-required`
- `block`

The MVP is complete only when the generic CLI, Claude Code, Codex, Cursor, and
GitHub Copilot adapters, redaction layer, rules, fixtures, and tests work
together.

## Stack

- Node.js and TypeScript
- one npm package
- Node built-ins before runtime dependencies
- Vitest or Node's test runner
- deterministic JSON rules under `rules/`
- no framework, database, network service, telemetry, account, API key, or LLM

## Input model

The core accepts a normalized inspection request:

```ts
type InspectionRequest = {
  source:
    | "cli"
    | "claude-code"
    | "codex"
    | "cursor"
    | "github-copilot"
    | "ci"
    | "generic";
  mode: "interactive" | "non-interactive";
  action: ShellAction | ToolAction | FileChangeAction;
};
```

Supported action forms:

- raw shell command plus optional argv;
- structured tool name and JSON arguments;
- file path plus added or changed text for Terraform inspection.

Never invoke a shell, use `eval`, resolve substitutions, read command output,
or execute a proposed tool.

## Output model

```ts
type Decision = {
  version: "1";
  decision: "allow" | "approval-required" | "block";
  reasonCode: string;
  summary: string;
  inspection: {
    complete: boolean;
    issues: Array<{ code: string; message: string }>;
  };
  approvals?: Array<{
    provider: string;
    resource: string;
    billing: "one-time" | "recurring" | "usage-based" | "mixed" | "unknown";
    price: string;
  }>;
  approval?: {
    provider: string;
    resource: string;
    billing: "one-time" | "recurring" | "usage-based" | "mixed" | "unknown";
    price: string;
  };
  matches: Array<{
    ruleId: string;
    category: string;
    redactedEvidence?: string;
  }>;
};
```

Human text and JSON must describe uncertainty honestly. Never invent a price.
Rules may use configured price facts only when their source and scope are
explicit.

## Decision rules

### Allow

Return `allow` only when no enabled cost rule matches. It means only that this
cost policy found no cost-bearing action.

Hook adapters must preserve the host agent's existing permission checks. They
must not turn core `allow` into unconditional tool approval.

### Approval required

Return `approval-required` for a likely cost-bearing action or a conservative
match where the command can increase paid capacity.

The approval message must start with `Cost confirmation required:` and include
provider, resource, billing model, and known price or uncertainty.

### Block

Return `block` only for:

- malformed or unsupported hook input that cannot be inspected safely in
  strict mode;
- an attempt to disable, alter, or bypass the active guard;
- a configured hard-deny policy.

Do not expand this into a general security scanner.

## Rule engine

Use versioned JSON rule files under `rules/`.

Each rule includes:

- stable rule ID and version;
- provider and category;
- supported action form;
- exact command, subcommand, argument, path, or added-text matchers;
- decision and reason code;
- resource and billing description;
- test fixture references.

Initial coverage:

### AWS

- EC2, RDS, ElastiCache, S3, EBS and snapshot creation;
- paid capacity changes such as instance class, replicas, storage, throughput,
  autoscaling maximums, and provisioned concurrency;
- prepaid or commitment-like operations are approval-required, not silently
  allowed.

### Terraform

- `terraform apply` is approval-required;
- `terraform plan`, `validate`, `fmt`, `show`, and read-only state inspection
  are allowed unless a different rule matches;
- added provider resource blocks are approval-required;
- comments and removed resource blocks must not trigger a creation match.

### Cloudflare

- creation of paid-capable Workers, databases, storage namespaces, buckets,
  tunnels, load balancers, and capacity-related resources;
- plan or subscription changes;
- read-only list, status, tail, and configuration validation commands.

### Generic

- purchase credits;
- upgrade or enable a paid plan;
- create snapshots or paid backups;
- increase replicas, storage, throughput, workers, instances, or autoscaling
  capacity;
- disable or bypass the cost guard.

Avoid broad keywords that make harmless documentation or echo commands require
approval. Match command structure and tool arguments where possible.

## Redaction

Redact before building diagnostics, evidence, approval text, JSON, or logs.

Cover at minimum:

- authorization headers;
- key/value fields named token, secret, password, credential, private key, or
  API key;
- common cloud and source-control token formats;
- URLs containing user information;
- PEM private-key blocks;
- environment assignments with sensitive names.

Do not log raw hook input by default. Tests use fake credentials only.

## Adapters

### Claude Code

Read `PreToolUse` JSON from stdin. Inspect `Bash`, structured tool calls, and
Terraform file writes or edits when available.

Mapping:

- `allow`: exit successfully without a hook decision;
- `approval-required`: return `permissionDecision: "ask"` with the approval
  message;
- `block`: return `permissionDecision: "deny"`.

Use only valid structured hook output on stdout.

Official reference: [Claude Code hooks](https://code.claude.com/docs/en/hooks).

### Codex

Read `PreToolUse` JSON from stdin. Inspect supported local tool calls, including
shell commands and `apply_patch` changes.

Mapping:

- `allow`: exit successfully without a permission decision;
- `approval-required`: `deny` with the full approval message because Codex does
  not currently support `ask` as an interactive hook outcome;
- `block`: `deny`.

Codex hooks do not cover hosted tools, and specialized tool paths can opt out of
hook processing. Official reference: [Codex hooks](https://learn.chatgpt.com/docs/hooks).

### Cursor

Read `preToolUse` JSON from stdin and inspect supported Shell, Write,
ApplyPatch, and MCP tool payloads.

Mapping:

- `allow`: return neutral `{}` so Cursor keeps its normal permission flow;
- `approval-required`: `deny` with the full approval message because Cursor
  does not currently enforce `ask` for `preToolUse`;
- `block`: `deny`.

The project example must use `failClosed: true`. Cursor currently has a
[fast-exit deny-capture race](https://forum.cursor.com/t/race-condition-silently-disables-hooks-that-exit-quickly/165818/7),
so the integration must disclose that it is not an absolute enforcement
boundary. Official reference: [Cursor hooks](https://cursor.com/docs/hooks).

### GitHub Copilot CLI and VS Code

Read `preToolUse` input and inspect the proposed tool name and arguments.

Interactive mapping:

- `allow`: make no decision that weakens existing permissions;
- `approval-required`: `ask`;
- `block`: `deny`.

VS Code uses the same mapping but requires its decision under
`hookSpecificOutput`. The adapter must also recognize VS Code's native
`runTerminalCommand` shell tool name.

Cloud-agent mapping:

- `approval-required`: `deny` with the exact approval message because no user
  can answer during the job;
- `block`: `deny`.

Official reference: [GitHub Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference).

### Other agents

Agents without a first-class adapter use `inspect-json` with
`source: "generic"`. This is enforceable only when the host exposes a
before-tool hook or runs through a wrapper that can stop the proposed action.
Exit `0` means only "no cost match" and must never become automatic host
approval. Exit `2` maps to a reliable interactive prompt or otherwise to deny;
exits `3` and `64` map to deny.

## CLI

Commands:

```text
agent-cost-guard inspect [--json] [--strict] -- <command>
agent-cost-guard inspect-json [--strict]
agent-cost-guard hook claude-code [--strict|--no-strict]
agent-cost-guard hook codex [--strict|--no-strict]
agent-cost-guard hook cursor [--strict|--no-strict]
agent-cost-guard hook copilot [--mode interactive|cloud|vscode] [--strict|--no-strict]
agent-cost-guard doctor
agent-cost-guard rules list [--json]
agent-cost-guard rules explain <rule-id> [--json]
```

Exit codes:

- `0`: allow;
- `2`: approval required;
- `3`: block;
- `64`: invalid CLI usage.

Hook adapters follow their host protocol instead of the generic CLI exit-code
contract.

## Fixtures and tests

Every rule needs positive, negative, redaction, and near-match fixtures.

Required test groups:

- AWS create, modify, delete, list, and describe commands;
- Terraform additions, removals, comments, plan, and apply;
- Cloudflare create, deploy, list, and delete commands;
- generic credit, upgrade, backup, snapshot, and scaling requests;
- compound commands, quoting, environment assignments, and malformed input;
- fake secrets in every supported input form;
- Claude Code adapter protocol fixtures;
- Codex adapter protocol fixtures;
- Cursor adapter protocol fixtures;
- Copilot CLI, VS Code, and cloud-agent protocol fixtures;
- deterministic output snapshots;
- proof that inspection never starts a child process or network request.

## Repository layout

```text
src/
  adapters/
    claude-code.ts
    codex.ts
    cursor.ts
    github-copilot.ts
  core/
    classify.ts
    match.ts
    normalize.ts
    rules.ts
    tokenize.ts
    types.ts
  format/
    output.ts
  redaction/
    redact.ts
  bin.ts
  cli.ts
  index.ts
rules/
fixtures/
tests/
examples/
docs/
scripts/
```

## Finish line

- All three decisions have stable JSON and human output.
- Approval messages include every required field.
- Redaction happens before any output or diagnostic.
- Core inspection performs no execution or network access.
- AWS, Terraform, Cloudflare, and generic fixtures pass.
- All four host adapter families follow their official protocol.
- `allow` never bypasses native permission controls.
- Typecheck, lint, unit tests, package build, and CLI smoke tests pass.
- README examples match real CLI output.
