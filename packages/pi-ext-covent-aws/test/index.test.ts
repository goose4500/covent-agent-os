import { expect, test, beforeEach } from "bun:test";
import {
    buildExtension,
    runSsmGetSecret,
    runSqsSendEvent,
    runS3PutArtifact,
    runCloudWatchLogAudit,
    type AwsClients,
} from "../src/index.ts";

// --- Mock infra ---------------------------------------------------------

interface RegisteredTool {
    name: string;
    description: string;
    execute: (id: string, params: unknown) => Promise<unknown>;
}

interface MockPi {
    tools: Map<string, RegisteredTool>;
    eventHandlers: Map<string, (event: unknown) => Promise<unknown>>;
    audits: Array<{ type: string; data: unknown }>;
    api: {
        registerTool: (t: RegisteredTool) => void;
        on: (e: string, h: (event: unknown) => Promise<unknown>) => void;
        appendEntry: (type: string, data: unknown) => void;
    };
}

function mockPi(opts: { failingAppendEntry?: boolean; noAppendEntry?: boolean } = {}): MockPi {
    const tools = new Map<string, RegisteredTool>();
    const eventHandlers = new Map<string, (event: unknown) => Promise<unknown>>();
    const audits: Array<{ type: string; data: unknown }> = [];
    const api: MockPi["api"] = {
        registerTool: (t: RegisteredTool) => tools.set(t.name, t),
        on: (e, h) => eventHandlers.set(e, h),
        appendEntry: (type, data) => {
            if (opts.failingAppendEntry) throw new Error("simulated audit storage failure");
            audits.push({ type, data });
        },
    };
    if (opts.noAppendEntry) {
        delete (api as Partial<MockPi["api"]>).appendEntry;
    }
    return { tools, eventHandlers, audits, api };
}

interface SendCall {
    commandName: string;
    input: Record<string, unknown>;
}

function mockClients(responses: {
    ssm?: unknown;
    sqs?: unknown;
    s3?: unknown;
    cwl?: unknown;
}): { clients: AwsClients; calls: SendCall[] } {
    const calls: SendCall[] = [];
    const mk = (resp: unknown) => ({
        async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
            calls.push({ commandName: cmd.constructor.name, input: cmd.input });
            if (resp instanceof Error) throw resp;
            return resp;
        },
    });
    return {
        clients: {
            ssm: mk(responses.ssm) as unknown as AwsClients["ssm"],
            sqs: mk(responses.sqs) as unknown as AwsClients["sqs"],
            s3: mk(responses.s3) as unknown as AwsClients["s3"],
            cwl: mk(responses.cwl) as unknown as AwsClients["cwl"],
        },
        calls,
    };
}

beforeEach(() => {
    delete process.env.COVENT_LANE;
    delete process.env.AWS_REGION;
    // scrub any test-leaked env exports between runs
    for (const k of Object.keys(process.env)) {
        if (k.startsWith("TEST_SECRET_")) delete process.env[k];
    }
});

// --- Lane gating tests --------------------------------------------------

test("operator lane registers all 4 tools", () => {
    const pi = mockPi();
    const { clients } = mockClients({});
    buildExtension({
        lane: "operator",
        region: "us-east-1",
        clientsFactory: () => clients,
    })(pi.api as unknown as Parameters<ReturnType<typeof buildExtension>>[0]);

    expect(pi.tools.has("ssm_get_secret")).toBe(true);
    expect(pi.tools.has("sqs_send_event")).toBe(true);
    expect(pi.tools.has("s3_put_artifact")).toBe(true);
    expect(pi.tools.has("cloudwatch_log_audit")).toBe(true);
});

test("bridge lane registers ONLY ssm + sqs (no S3, no CloudWatch)", () => {
    const pi = mockPi();
    const { clients } = mockClients({});
    buildExtension({
        lane: "bridge",
        region: "us-east-1",
        clientsFactory: () => clients,
    })(pi.api as unknown as Parameters<ReturnType<typeof buildExtension>>[0]);

    expect(pi.tools.has("ssm_get_secret")).toBe(true);
    expect(pi.tools.has("sqs_send_event")).toBe(true);
    expect(pi.tools.has("s3_put_artifact")).toBe(false);
    expect(pi.tools.has("cloudwatch_log_audit")).toBe(false);
    expect(pi.tools.size).toBe(2);
});

// --- ssm_get_secret: secret-leak resistance ----------------------------

test("runSsmGetSecret: exports value to process.env, never returns it", async () => {
    const { clients, calls } = mockClients({
        ssm: { Parameter: { Name: "/covent/test", Value: "hunter2" } },
    });
    const result = await runSsmGetSecret(
        { name: "/covent/test", export_as: "TEST_SECRET_HUNTER" },
        clients,
    );
    expect(process.env.TEST_SECRET_HUNTER).toBe("hunter2");
    expect(result).toMatchObject({
        name: "/covent/test",
        exported_to: "TEST_SECRET_HUNTER",
        bytes: 7,
    });
    // Returned shape MUST NOT contain the value
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect((result as Record<string, unknown>).value).toBeUndefined();
    expect(calls[0].input).toMatchObject({ Name: "/covent/test", WithDecryption: true });
});

test("ssm tool envelope (full Pi response) does not contain the secret value", async () => {
    const pi = mockPi();
    const { clients } = mockClients({
        ssm: { Parameter: { Name: "/covent/leaktest", Value: "PLAINTEXT_SECRET_42" } },
    });
    buildExtension({
        lane: "operator",
        region: "us-east-1",
        clientsFactory: () => clients,
    })(pi.api as unknown as Parameters<ReturnType<typeof buildExtension>>[0]);

    const tool = pi.tools.get("ssm_get_secret")!;
    const response = await tool.execute("call-1", {
        name: "/covent/leaktest",
        export_as: "TEST_SECRET_LEAK",
    });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("PLAINTEXT_SECRET_42");
    expect(process.env.TEST_SECRET_LEAK).toBe("PLAINTEXT_SECRET_42");
});

test("runSsmGetSecret: rejects invalid env var names", async () => {
    const { clients } = mockClients({ ssm: { Parameter: { Value: "x" } } });
    await expect(
        runSsmGetSecret({ name: "/x", export_as: "lowercase_bad" }, clients),
    ).rejects.toThrow(/invalid env var name/);
    await expect(
        runSsmGetSecret({ name: "/x", export_as: "9_LEADING_DIGIT" }, clients),
    ).rejects.toThrow(/invalid env var name/);
    await expect(
        runSsmGetSecret({ name: "/x", export_as: "WITH SPACE" }, clients),
    ).rejects.toThrow(/invalid env var name/);
});

test("runSsmGetSecret: throws if parameter has no Value", async () => {
    const { clients } = mockClients({ ssm: { Parameter: {} } });
    await expect(
        runSsmGetSecret({ name: "/covent/missing", export_as: "TEST_SECRET_MISS" }, clients),
    ).rejects.toThrow(/returned no Value/);
});

// --- sqs_send_event ----------------------------------------------------

test("runSqsSendEvent: maps body to MessageBody, returns message_id", async () => {
    const { clients, calls } = mockClients({ sqs: { MessageId: "abc-123" } });
    const result = await runSqsSendEvent(
        { queue_url: "https://sqs.us-east-1.amazonaws.com/1/q", body: '{"x":1}' },
        clients,
    );
    expect(result.message_id).toBe("abc-123");
    expect(calls[0].input).toMatchObject({
        QueueUrl: "https://sqs.us-east-1.amazonaws.com/1/q",
        MessageBody: '{"x":1}',
    });
});

test("runSqsSendEvent: passes message_group_id for FIFO queues", async () => {
    const { clients, calls } = mockClients({ sqs: { MessageId: "fifo-1" } });
    await runSqsSendEvent(
        {
            queue_url: "https://sqs.us-east-1.amazonaws.com/1/q.fifo",
            body: "x",
            message_group_id: "lane-bridge",
        },
        clients,
    );
    expect(calls[0].input).toMatchObject({ MessageGroupId: "lane-bridge" });
});

// --- s3_put_artifact: text vs binary -----------------------------------

test("runS3PutArtifact: text body passes through with text/plain content type", async () => {
    const { clients, calls } = mockClients({ s3: { ETag: '"abc"' } });
    const result = await runS3PutArtifact(
        { bucket: "covent-pi-artifacts", key: "diagnostics/x.txt", body: "hello world" },
        clients,
    );
    expect(result.etag).toBe('"abc"');
    expect(calls[0].input.Body).toBe("hello world");
    expect(calls[0].input.ContentType).toBe("text/plain; charset=utf-8");
});

test("runS3PutArtifact: body_base64 decodes to bytes with octet-stream default", async () => {
    const { clients, calls } = mockClients({ s3: { ETag: '"bin"' } });
    await runS3PutArtifact(
        {
            bucket: "covent-pi-artifacts",
            key: "screenshots/x.png",
            body_base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
            content_type: "image/png",
        },
        clients,
    );
    const body = calls[0].input.Body as Uint8Array;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(Array.from(body)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(calls[0].input.ContentType).toBe("image/png");
});

test("runS3PutArtifact: body_base64 default content type is application/octet-stream", async () => {
    const { clients, calls } = mockClients({ s3: { ETag: '"bin"' } });
    await runS3PutArtifact(
        {
            bucket: "b",
            key: "k",
            body_base64: Buffer.from("hi").toString("base64"),
        },
        clients,
    );
    expect(calls[0].input.ContentType).toBe("application/octet-stream");
});

test("runS3PutArtifact: rejects neither body nor body_base64", async () => {
    const { clients } = mockClients({ s3: {} });
    await expect(runS3PutArtifact({ bucket: "b", key: "k" }, clients)).rejects.toThrow(
        /exactly one of/,
    );
});

test("runS3PutArtifact: rejects both body and body_base64", async () => {
    const { clients } = mockClients({ s3: {} });
    await expect(
        runS3PutArtifact(
            { bucket: "b", key: "k", body: "x", body_base64: "eA==" },
            clients,
        ),
    ).rejects.toThrow(/exactly one of/);
});

// --- cloudwatch_log_audit ----------------------------------------------

test("runCloudWatchLogAudit: builds single PutLogEvents with current timestamp", async () => {
    const { clients, calls } = mockClients({ cwl: { nextSequenceToken: "tok-1" } });
    const before = Date.now();
    const result = await runCloudWatchLogAudit(
        {
            log_group: "/covent/pi/operator",
            log_stream: "audit-2026-05",
            message: '{"action":"s3_put"}',
        },
        clients,
    );
    const after = Date.now();
    expect(result.next_sequence_token).toBe("tok-1");
    const events = calls[0].input.logEvents as Array<{ timestamp: number; message: string }>;
    expect(events.length).toBe(1);
    expect(events[0].message).toBe('{"action":"s3_put"}');
    expect(events[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(events[0].timestamp).toBeLessThanOrEqual(after);
});

test("runCloudWatchLogAudit: passes sequence_token to AWS when provided", async () => {
    const { clients, calls } = mockClients({ cwl: { nextSequenceToken: "tok-2" } });
    await runCloudWatchLogAudit(
        {
            log_group: "/covent/pi/operator",
            log_stream: "audit",
            message: "x",
            sequence_token: "previous-token-abc",
        },
        clients,
    );
    expect(calls[0].input.sequenceToken).toBe("previous-token-abc");
});

test("runCloudWatchLogAudit: omits sequenceToken when not provided", async () => {
    const { clients, calls } = mockClients({ cwl: { nextSequenceToken: "tok-3" } });
    await runCloudWatchLogAudit(
        { log_group: "g", log_stream: "s", message: "x" },
        clients,
    );
    expect(calls[0].input.sequenceToken).toBeUndefined();
});

// --- Error propagation --------------------------------------------------

test("AWS errors propagate as thrown errors (not swallowed)", async () => {
    const { clients } = mockClients({ ssm: new Error("AccessDeniedException") });
    await expect(
        runSsmGetSecret(
            { name: "/covent/forbidden", export_as: "TEST_SECRET_FORBIDDEN" },
            clients,
        ),
    ).rejects.toThrow("AccessDeniedException");
});

// --- Audit hook --------------------------------------------------------

test("audit hook fires for AWS tool calls and skips non-AWS tools", async () => {
    const pi = mockPi();
    const { clients } = mockClients({});
    buildExtension({
        lane: "operator",
        region: "us-east-1",
        clientsFactory: () => clients,
    })(pi.api as unknown as Parameters<ReturnType<typeof buildExtension>>[0]);

    const handler = pi.eventHandlers.get("tool_call")!;
    await handler({ toolName: "s3_put_artifact" });
    await handler({ toolName: "ssm_get_secret" });
    await handler({ toolName: "bash" }); // non-AWS, should be ignored

    expect(pi.audits.length).toBe(2);
    expect(pi.audits[0]).toMatchObject({
        type: "covent_aws_audit",
        data: { lane: "operator", tool: "s3_put_artifact" },
    });
});

test("audit entries do NOT contain tool args (secrets safety)", async () => {
    const pi = mockPi();
    const { clients } = mockClients({});
    buildExtension({
        lane: "operator",
        region: "us-east-1",
        clientsFactory: () => clients,
    })(pi.api as unknown as Parameters<ReturnType<typeof buildExtension>>[0]);

    const handler = pi.eventHandlers.get("tool_call")!;
    await handler({
        toolName: "ssm_get_secret",
        input: { name: "/covent/secret/should/never/log" },
    });
    expect(JSON.stringify(pi.audits[0])).not.toContain("/covent/secret/should/never/log");
});

test("audit hook silently skips when appendEntry is absent (older Pi)", async () => {
    const pi = mockPi({ noAppendEntry: true });
    const { clients } = mockClients({});
    buildExtension({
        lane: "operator",
        region: "us-east-1",
        clientsFactory: () => clients,
    })(pi.api as unknown as Parameters<ReturnType<typeof buildExtension>>[0]);
    const handler = pi.eventHandlers.get("tool_call")!;
    // Must not throw — feature absence is not an error
    await expect(handler({ toolName: "s3_put_artifact" })).resolves.toBeUndefined();
});

test("audit hook warns (not throws) when appendEntry throws", async () => {
    const pi = mockPi({ failingAppendEntry: true });
    const { clients } = mockClients({});
    buildExtension({
        lane: "operator",
        region: "us-east-1",
        clientsFactory: () => clients,
    })(pi.api as unknown as Parameters<ReturnType<typeof buildExtension>>[0]);

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
        warnings.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
    try {
        const handler = pi.eventHandlers.get("tool_call")!;
        await expect(handler({ toolName: "s3_put_artifact" })).resolves.toBeUndefined();
    } finally {
        console.warn = origWarn;
    }
    expect(warnings.some((w) => w.includes("appendEntry failed"))).toBe(true);
});

// --- Env-var resolution -------------------------------------------------

test("default export is dormant (no tools registered, no throw) when COVENT_LANE unset", async () => {
    const pi = mockPi();
    const mod = await import("../src/index.ts");
    expect(() =>
        mod.default(pi.api as unknown as Parameters<typeof mod.default>[0]),
    ).not.toThrow();
    expect(pi.tools.size).toBe(0);
    expect(pi.eventHandlers.size).toBe(0);
});

test("default export with COVENT_LANE set but AWS_REGION unset DOES throw (real misconfig)", async () => {
    process.env.COVENT_LANE = "operator";
    const pi = mockPi();
    const mod = await import("../src/index.ts");
    expect(() =>
        mod.default(pi.api as unknown as Parameters<typeof mod.default>[0]),
    ).toThrow(/AWS_REGION/);
});

test("buildExtension throws if AWS_REGION unset", () => {
    process.env.COVENT_LANE = "operator";
    const pi = mockPi();
    expect(() =>
        buildExtension({ lane: "operator" })(
            pi.api as unknown as Parameters<ReturnType<typeof buildExtension>>[0],
        ),
    ).toThrow(/AWS_REGION/);
});
