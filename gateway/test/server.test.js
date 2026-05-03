import assert from "node:assert/strict";
import test from "node:test";

import { buildLoggerOptions, buildServer } from "../src/server.js";

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
