import assert from "node:assert/strict";
import test from "node:test";

import { buildLoggerOptions, buildServer, installGracefulShutdown } from "../src/server.js";

const config = {
    server: {
        host: "127.0.0.1",
        port: 0,
        path: "/mcp",
        allowedOrigins: ["https://app.example.com"]
    },
    auth: {
        mode: "apiKey",
        apiKeys: [{ key: "dev_key_1", tenant: "client", client: "local-dev" }]
    },
    rateLimit: {
        keyPrefix: "mcp-gateway",
        defaultRpm: 600,
        byMethod: {}
    },
    policy: {
        default: "allow",
        rules: []
    },
    upstreams: [
        { name: "mcp-local", type: "http", url: "http://127.0.0.1:9000/mcp" }
    ],
    routing: [
        { match: { method: "*" }, upstream: "mcp-local" }
    ],
    audit: {
        enabled: false,
        environments: ["*"]
    },
    logging: {
        level: "silent",
        redactKeys: []
    }
};

const mcpHeaders = {
    origin: "https://app.example.com",
    authorization: "Bearer dev_key_1",
    "content-type": "application/json"
};

test("builds pino redaction paths from logging redactKeys", () => {
    const loggerOptions = buildLoggerOptions({
        level: "debug",
        redactKeys: ["authorization", "x-api-key", "password"]
    });

    assert.equal(loggerOptions.level, "debug");
    assert.equal(loggerOptions.redact.censor, "[REDACTED]");
    assert.ok(loggerOptions.redact.paths.includes("authorization"));
    assert.ok(loggerOptions.redact.paths.includes("req.headers.authorization"));
    assert.ok(loggerOptions.redact.paths.includes("headers[\"x-api-key\"]"));
    assert.ok(loggerOptions.redact.paths.includes("request.headers.password"));
    assert.ok(loggerOptions.redact.paths.includes("body.password"));
    assert.ok(loggerOptions.redact.paths.includes("req.body.params.arguments.password"));
    assert.ok(loggerOptions.redact.paths.includes("body[*].params.arguments.password"));
    assert.ok(loggerOptions.redact.paths.includes("err.config.headers.authorization"));
});

test("omits pino redact options when no redactKeys are configured", () => {
    const loggerOptions = buildLoggerOptions({ level: "info", redactKeys: [] });

    assert.deepEqual(loggerOptions, { level: "info" });
});

test("health endpoints are available without gateway auth or origin headers", async () => {
    const app = await buildServer(config, { env: {} });
    test.after(async () => app.close());

    for (const url of ["/healthz", "/health"]) {
        const response = await app.inject({ method: "GET", url });
        const body = response.json();

        assert.equal(response.statusCode, 200);
        assert.equal(body.status, "ok");
        assert.equal(body.service, "mcp-gateway");
        assert.equal(body.checks.rateLimit.status, "ok");
        assert.equal(body.checks.rateLimit.type, "memory");
    }
});

test("MCP POST auth failures return JSON-RPC errors", async () => {
    const app = await buildServer(config, { env: {} });
    test.after(async () => app.close());

    const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
            origin: "https://app.example.com",
            "content-type": "application/json"
        },
        payload: { jsonrpc: "2.0", id: 7, method: "tools/list" }
    });
    const body = response.json();

    assert.equal(response.statusCode, 401);
    assert.deepEqual(body, {
        jsonrpc: "2.0",
        id: null,
        error: {
            code: -32001,
            message: "Missing API key"
        }
    });
});

test("MCP POST policy failures preserve JSON-RPC ids", async () => {
    const app = await buildServer({
        ...config,
        policy: {
            default: "allow",
            rules: [
                {
                    subject: { tenant: "client", client: "local-dev" },
                    deny: { methods: ["tools/call"] }
                }
            ]
        }
    }, { env: {} });
    test.after(async () => app.close());

    const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: mcpHeaders,
        payload: { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "secret" } }
    });
    const body = response.json();

    assert.equal(response.statusCode, 403);
    assert.deepEqual(body, {
        jsonrpc: "2.0",
        id: 9,
        error: {
            code: -32003,
            message: "Denied method: tools/call"
        }
    });
});

test("MCP POST batch rate-limit failures return JSON-RPC batch errors", async () => {
    const app = await buildServer({
        ...config,
        rateLimit: {
            ...config.rateLimit,
            defaultRpm: 1
        }
    }, { env: {} });
    test.after(async () => app.close());

    const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: mcpHeaders,
        payload: [
            { jsonrpc: "2.0", id: 1, method: "tools/list" },
            { jsonrpc: "2.0", id: 2, method: "tools/list" }
        ]
    });
    const body = response.json();

    assert.equal(response.statusCode, 429);
    assert.deepEqual(body, [
        {
            jsonrpc: "2.0",
            id: 1,
            error: {
                code: -32029,
                message: "Rate limit exceeded"
            }
        },
        {
            jsonrpc: "2.0",
            id: 2,
            error: {
                code: -32029,
                message: "Rate limit exceeded"
            }
        }
    ]);
});

test("graceful shutdown closes the app and exits cleanly", async () => {
    const handlers = new Map();
    const exits = [];
    const processLike = {
        once(signal, handler) {
            handlers.set(signal, handler);
        },
        off(signal, handler) {
            if (handlers.get(signal) === handler) handlers.delete(signal);
        }
    };

    const app = await buildServer(config, { env: {} });
    let closed = false;
    app.addHook("onClose", async () => {
        closed = true;
    });

    installGracefulShutdown(app, {
        processLike,
        timeoutMs: 100,
        exit: (code) => exits.push(code)
    });

    assert.equal(typeof handlers.get("SIGTERM"), "function");

    await handlers.get("SIGTERM")();

    assert.equal(closed, true);
    assert.deepEqual(exits, [0]);
    assert.equal(handlers.has("SIGTERM"), false);
    assert.equal(handlers.has("SIGINT"), false);
});
