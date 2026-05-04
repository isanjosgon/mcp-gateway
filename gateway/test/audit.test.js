import assert from "node:assert/strict";
import test from "node:test";

import { audit, isAuditEnabled, resolveAuditEnvironment } from "../src/middlewares/audit.js";

test("resolves audit environment from MCP_GATEWAY_ENV first", () => {
    assert.equal(
        resolveAuditEnvironment({ MCP_GATEWAY_ENV: "production", NODE_ENV: "test" }),
        "production"
    );
});

test("resolves audit environment from NODE_ENV when MCP_GATEWAY_ENV is not set", () => {
    assert.equal(resolveAuditEnvironment({ NODE_ENV: "staging" }), "staging");
});

test("defaults audit environment to development", () => {
    assert.equal(resolveAuditEnvironment({}), "development");
});

test("enables audit for wildcard environments", () => {
    assert.equal(
        isAuditEnabled({ audit: { enabled: true, environments: ["*"] } }, { NODE_ENV: "test" }),
        true
    );
});

test("enables audit only for matching environments", () => {
    const cfg = { audit: { enabled: true, environments: ["production", "staging"] } };

    assert.equal(isAuditEnabled(cfg, { MCP_GATEWAY_ENV: "production" }), true);
    assert.equal(isAuditEnabled(cfg, { MCP_GATEWAY_ENV: "development" }), false);
});

test("disables audit when configured off", () => {
    assert.equal(
        isAuditEnabled({ audit: { enabled: false, environments: ["*"] } }, { NODE_ENV: "production" }),
        false
    );
});

test("audit log includes resolved environment and request metadata", async () => {
    const calls = [];
    const req = {
        requestId: "req-1",
        method: "POST",
        subject: { tenant: "client", client: "local-dev", apiKeyId: "local-dev-key" },
        body: {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "echo" }
        },
        log: {
            info(data, message) {
                calls.push({ data, message });
            }
        }
    };
    const reply = { statusCode: 200 };

    await audit({}, { env: { MCP_GATEWAY_ENV: "production" } })(req, reply);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].message, "audit");
    assert.deepEqual(calls[0].data, {
        requestId: "req-1",
        tenant: "client",
        client: "local-dev",
        apiKeyId: "local-dev-key",
        environment: "production",
        httpMethod: "POST",
        mcpMethod: "tools/call",
        toolName: "echo",
        statusCode: 200
    });
});
