# pi-ext-covent-aws

Pi extension exposing scoped AWS primitives for the Covent Pi workbench.

## Tools

| Tool | Purpose | Bridge lane | Operator lane |
|---|---|---|---|
| `ssm_get_secret` | Read parameter from SSM, **export to `process.env`** (value never returned to LLM) | yes | yes |
| `sqs_send_event` | Send typed event to SQS queue | yes | yes |
| `s3_put_artifact` | Upload object to S3 (text via `body`, binary via `body_base64`) | no | yes |
| `cloudwatch_log_audit` | Append audit event to CloudWatch Logs (chain `sequence_token`) | no | yes |

### Secret-leak resistance

`ssm_get_secret` does **not** return the secret value in its tool response.
It writes the value to `process.env[export_as]` and returns only the env var
name and byte length. Downstream tools that need the secret read it from env.
The LLM orchestrates by env-var-name and never sees the plaintext.

### CloudWatch sequence tokens

`PutLogEvents` requires a `sequenceToken` after the first call to a stream
that already has events. The tool surfaces `next_sequence_token` in its
response — chain it back as `sequence_token` on the next call to the same
stream. Recommended pattern: rotate streams daily (`audit-2026-05-08`) so
sequence churn is bounded and a missed token doesn't wedge the pipeline.

## Lane gating

Set `COVENT_LANE=bridge` or `COVENT_LANE=operator`. Tools register conditionally
based on lane — IAM enforces at the AWS layer; this extension enforces at the
Pi tool layer so the bridge cannot even be asked to put to S3.

## Auth

Uses the AWS SDK v3 default credential chain. On EC2: the instance profile.
Locally: `AWS_PROFILE` or `AWS_ACCESS_KEY_ID` env. **No credentials in code.**

## Region

Defaults to `AWS_REGION` env. If unset, tool calls fail with a descriptive
error (no silent us-east-1 fallback).

## Install

```sh
cd /path/to/pi-ext-covent-aws
bun install
pi install "$PWD"
```

> **Why `pi install` and not a symlink?** This extension imports real npm
> packages (`@aws-sdk/client-*`). Pi follows symlinks but resolves modules
> from the symlink's *path*, not the target — so a flat-file symlink in
> `~/.pi/agent/extensions/` cannot find this package's `node_modules`.
> `pi install` registers the package properly so its `node_modules` is
> visible to the loader. (Symlink is fine for type-only / no-runtime-dep
> extensions like `pi-ext-env-guard`.)

## Required env vars

```sh
export COVENT_LANE=operator   # or "bridge"
export AWS_REGION=us-east-1
```

Both fail loud at extension load if unset — no silent defaults.

## Test

```sh
bun test
bun run typecheck
```

## Why a Tier-2 extension

The 4 AWS clients are stateless wrappers — by themselves they could be a
Tier-1 uv-script. This is Tier-2 because:

1. Lane gating uses Pi's tool registration to make `s3_put_artifact`
   structurally invisible on the bridge — not just refused at runtime.
2. Audit logging hooks `tool_call` events to ship every privileged action
   to CloudWatch with structured context the LLM never sees.

If those two stop being true, refactor down to Tier-1.
