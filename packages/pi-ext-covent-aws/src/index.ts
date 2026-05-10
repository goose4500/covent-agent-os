// node-compat: no Bun APIs — Pi's jiti loader runs extensions under Node
/**
 * pi-ext-covent-aws
 *
 * Lane-gated AWS primitives for the Covent Pi workbench.
 *
 * Tools (registered conditionally based on COVENT_LANE):
 *   - ssm_get_secret       (bridge + operator) — exports secret to process.env, never returns the value
 *   - sqs_send_event       (bridge + operator)
 *   - s3_put_artifact      (operator only)
 *   - cloudwatch_log_audit (operator only)
 *
 * Auth: AWS SDK v3 default credential chain. EC2 instance profile in prod,
 * AWS_PROFILE/AWS_ACCESS_KEY_ID locally. NEVER reads credentials from args.
 *
 * Region: read from AWS_REGION; tool calls fail loud if unset.
 *
 * Tier-2 framework justification:
 *   - Lane gating uses Pi tool registration to make operator-only tools
 *     structurally absent on the bridge (not just refused at runtime).
 *   - SSM tool is exfiltrate-by-design: secrets flow to process.env (which the
 *     LLM does not see) rather than into the tool envelope (which the LLM does).
 *   - Audit hook ships every privileged tool call to a session entry invisible
 *     to the LLM (uses pi.appendEntry).
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";

import { CloudWatchLogsClient, PutLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

// --- Lane resolution ---------------------------------------------------

export type Lane = "bridge" | "operator";

export function resolveLane(): Lane {
    const raw = process.env.COVENT_LANE?.trim().toLowerCase();
    if (raw === "bridge" || raw === "operator") return raw;
    throw new Error(
        `pi-ext-covent-aws: COVENT_LANE must be "bridge" or "operator" (got: ${raw ?? "unset"})`,
    );
}

export function resolveRegion(): string {
    const region = process.env.AWS_REGION?.trim();
    if (!region) {
        throw new Error("pi-ext-covent-aws: AWS_REGION env is required (no silent default)");
    }
    return region;
}

// --- Client factories (deferred so tests can mock) ---------------------

export interface AwsClients {
    ssm: Pick<SSMClient, "send">;
    sqs: Pick<SQSClient, "send">;
    s3: Pick<S3Client, "send">;
    cwl: Pick<CloudWatchLogsClient, "send">;
}

export function defaultClients(region: string): AwsClients {
    return {
        ssm: new SSMClient({ region }),
        sqs: new SQSClient({ region }),
        s3: new S3Client({ region }),
        cwl: new CloudWatchLogsClient({ region }),
    };
}

// --- Env-var name validation -------------------------------------------

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
function assertValidEnvName(name: string): void {
    if (!ENV_NAME_RE.test(name)) {
        throw new Error(
            `pi-ext-covent-aws: invalid env var name "${name}" — must match /^[A-Z][A-Z0-9_]{0,127}$/`,
        );
    }
}

// --- Tool schemas ------------------------------------------------------

const SsmGetSecretInput = Type.Object({
    name: Type.String({ description: "SSM parameter name (e.g. /covent/pi/slack/bot_token)" }),
    export_as: Type.String({
        description:
            "Env var name to export the secret to (e.g. SLACK_BOT_TOKEN). The secret value is NEVER returned in the tool response — downstream tools must read from process.env.",
    }),
    with_decryption: Type.Optional(Type.Boolean()),
});

const SqsSendEventInput = Type.Object({
    queue_url: Type.String({ description: "Full SQS queue URL" }),
    body: Type.String({
        description: "JSON-serialized event payload (caller is responsible for schema)",
    }),
    message_group_id: Type.Optional(
        Type.String({ description: "FIFO group id, required for FIFO queues" }),
    ),
});

const S3PutArtifactInput = Type.Object({
    bucket: Type.String(),
    key: Type.String({ description: "Object key (path-like, no leading slash)" }),
    body: Type.Optional(Type.String({ description: "UTF-8 string body" })),
    body_base64: Type.Optional(
        Type.String({ description: "Base64-encoded binary body (mutually exclusive with body)" }),
    ),
    content_type: Type.Optional(Type.String()),
});

const CloudWatchLogAuditInput = Type.Object({
    log_group: Type.String({ description: "CloudWatch log group name (e.g. /covent/pi/operator)" }),
    log_stream: Type.String({
        description:
            "Log stream name. Recommended pattern: include a date or session id (e.g. audit-2026-05-08) so streams stay short-lived and sequence-token churn is bounded.",
    }),
    message: Type.String({ description: "JSON-serialized audit event" }),
    sequence_token: Type.Optional(
        Type.String({
            description:
                "Sequence token from a previous PutLogEvents response on the same stream. Required if the stream has prior events and you want strict ordering. Caller is expected to chain next_sequence_token.",
        }),
    ),
});

// --- Tool implementations ----------------------------------------------

export async function runSsmGetSecret(
    args: Static<typeof SsmGetSecretInput>,
    clients: AwsClients,
): Promise<{ name: string; exported_to: string; bytes: number }> {
    assertValidEnvName(args.export_as);
    const out = await (clients.ssm as SSMClient).send(
        new GetParameterCommand({
            Name: args.name,
            WithDecryption: args.with_decryption ?? true,
        }),
    );
    const value = out.Parameter?.Value;
    if (typeof value !== "string") {
        throw new Error(`ssm_get_secret: parameter ${args.name} returned no Value`);
    }
    process.env[args.export_as] = value;
    return { name: args.name, exported_to: args.export_as, bytes: Buffer.byteLength(value, "utf8") };
}

export async function runSqsSendEvent(
    args: Static<typeof SqsSendEventInput>,
    clients: AwsClients,
): Promise<{ message_id: string }> {
    const out = await (clients.sqs as SQSClient).send(
        new SendMessageCommand({
            QueueUrl: args.queue_url,
            MessageBody: args.body,
            MessageGroupId: args.message_group_id,
        }),
    );
    if (!out.MessageId) throw new Error("sqs_send_event: no MessageId returned");
    return { message_id: out.MessageId };
}

export async function runS3PutArtifact(
    args: Static<typeof S3PutArtifactInput>,
    clients: AwsClients,
): Promise<{ etag: string | undefined; key: string }> {
    if ((args.body == null) === (args.body_base64 == null)) {
        throw new Error("s3_put_artifact: provide exactly one of `body` (text) or `body_base64`");
    }
    const body: Uint8Array | string =
        args.body_base64 != null ? Buffer.from(args.body_base64, "base64") : (args.body as string);

    const out = await (clients.s3 as S3Client).send(
        new PutObjectCommand({
            Bucket: args.bucket,
            Key: args.key,
            Body: body,
            ContentType:
                args.content_type ??
                (args.body_base64 != null ? "application/octet-stream" : "text/plain; charset=utf-8"),
        }),
    );
    return { etag: out.ETag, key: args.key };
}

export async function runCloudWatchLogAudit(
    args: Static<typeof CloudWatchLogAuditInput>,
    clients: AwsClients,
): Promise<{ next_sequence_token: string | undefined }> {
    const out = await (clients.cwl as CloudWatchLogsClient).send(
        new PutLogEventsCommand({
            logGroupName: args.log_group,
            logStreamName: args.log_stream,
            logEvents: [{ timestamp: Date.now(), message: args.message }],
            sequenceToken: args.sequence_token,
        }),
    );
    return { next_sequence_token: out.nextSequenceToken };
}

// --- Pi extension registration ----------------------------------------

export interface ExtensionOptions {
    lane?: Lane;
    region?: string;
    clientsFactory?: (region: string) => AwsClients;
}

function envelope<T>(summary: string, details: T) {
    return {
        content: [{ type: "text" as const, text: summary }],
        details,
    };
}

// Single typed wrapper around pi.registerTool — keeps the typebox-shim cast
// contained at one boundary instead of repeated at every call site.
type PiRegisterToolArg = Parameters<ExtensionAPI["registerTool"]>[0];
function reg(pi: ExtensionAPI, tool: unknown) {
    (pi.registerTool as (t: PiRegisterToolArg) => void)(tool as PiRegisterToolArg);
}

export function buildExtension(opts: ExtensionOptions = {}) {
    return function extension(pi: ExtensionAPI) {
        const lane = opts.lane ?? resolveLane();
        const region = opts.region ?? resolveRegion();
        const factory = opts.clientsFactory ?? defaultClients;
        const clients = factory(region);

        // Tools available in BOTH lanes ----------------------------------
        reg(pi, {
            name: "ssm_get_secret",
            label: "AWS SSM: Get Secret (export to env)",
            description:
                "Read a secret from AWS SSM Parameter Store and export it to process.env[export_as]. The secret value is NEVER returned in the tool response — downstream tools must read from process.env. Auth via instance profile / AWS_PROFILE.",
            parameters: SsmGetSecretInput,
            async execute(_toolCallId: string, params: Static<typeof SsmGetSecretInput>) {
                const result = await runSsmGetSecret(params, clients);
                return envelope(
                    `Exported SSM parameter ${result.name} to env var ${result.exported_to} (${result.bytes} bytes, value withheld)`,
                    result,
                );
            },
        });

        reg(pi, {
            name: "sqs_send_event",
            label: "AWS SQS: Send Event",
            description:
                "Send a typed event to an SQS queue. Use this to hand off work between Pi lanes.",
            parameters: SqsSendEventInput,
            async execute(_toolCallId: string, params: Static<typeof SqsSendEventInput>) {
                const result = await runSqsSendEvent(params, clients);
                return envelope(`Sent SQS message ${result.message_id}`, result);
            },
        });

        // Operator-only tools --------------------------------------------
        if (lane === "operator") {
            reg(pi, {
                name: "s3_put_artifact",
                label: "AWS S3: Put Artifact",
                description:
                    "Upload an artifact to an S3 bucket. Use for repo diagnostics outputs, screenshots, audit dumps. Provide exactly one of `body` (text) or `body_base64` (binary).",
                parameters: S3PutArtifactInput,
                async execute(_toolCallId: string, params: Static<typeof S3PutArtifactInput>) {
                    const result = await runS3PutArtifact(params, clients);
                    return envelope(`Uploaded s3://${params.bucket}/${result.key}`, result);
                },
            });

            reg(pi, {
                name: "cloudwatch_log_audit",
                label: "AWS CloudWatch: Log Audit Event",
                description:
                    "Append a structured audit event to CloudWatch Logs. Mandatory for any privileged action. Pass `sequence_token` from a prior response if the stream already has events.",
                parameters: CloudWatchLogAuditInput,
                async execute(
                    _toolCallId: string,
                    params: Static<typeof CloudWatchLogAuditInput>,
                ) {
                    const result = await runCloudWatchLogAudit(params, clients);
                    return envelope(`Logged audit event to ${params.log_group}`, result);
                },
            });
        }

        // Audit hook: every AWS tool call gets a session entry invisible to the LLM
        const aws_tools = new Set([
            "ssm_get_secret",
            "sqs_send_event",
            "s3_put_artifact",
            "cloudwatch_log_audit",
        ]);
        pi.on("tool_call", async (event: { toolName: string }) => {
            if (!aws_tools.has(event.toolName)) return undefined;
            const append = (pi as unknown as { appendEntry?: (t: string, d: unknown) => void })
                .appendEntry;
            if (typeof append !== "function") return undefined; // older Pi: feature absent, not an error
            try {
                append("covent_aws_audit", {
                    ts: new Date().toISOString(),
                    lane,
                    tool: event.toolName,
                    // intentionally do NOT log args — they may contain secrets
                });
            } catch (err) {
                // appendEntry exists but threw — surface to operator console; never block tool exec
                console.warn(
                    "pi-ext-covent-aws: appendEntry failed (audit entry dropped)",
                    err instanceof Error ? err.message : err,
                );
            }
            return undefined;
        });
    };
}

// Default export = the registration function Pi calls at load.
//
// Opt-in semantics: the extension is dormant unless COVENT_LANE is set.
// This keeps the extension globally installable without breaking Pi sessions
// that aren't running in a Covent AWS context. Once COVENT_LANE is set,
// AWS_REGION missing is a real misconfiguration and DOES still throw.
export default function (pi: ExtensionAPI) {
    if (!process.env.COVENT_LANE) return; // dormant — set COVENT_LANE=bridge|operator to activate
    return buildExtension()(pi);
}
