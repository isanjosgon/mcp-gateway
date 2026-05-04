import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../src/config.js";

const baseConfig = {
    server: {
        host: "127.0.0.1",
        port: 8080,
        path: "/mcp",
        allowedOrigins: []
    },
    auth: {
        mode: "none",
        apiKeys: []
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
    ]
};

test("accepts routing rules that reference configured upstreams", () => {
    const config = parseConfig(baseConfig);

    assert.equal(config.routing[0].upstream, "mcp-local");
});

test("rejects routing rules that reference unknown upstreams", () => {
    assert.throws(
        () => parseConfig({
            ...baseConfig,
            routing: [
                { match: { method: "*" }, upstream: "missing-upstream" }
            ]
        }),
        /Unknown upstream: missing-upstream/
    );
});

test("accepts hashed API key entries", () => {
    const config = parseConfig({
        ...baseConfig,
        auth: {
            mode: "apiKey",
            apiKeys: [
                {
                    id: "hashed-key",
                    keyHash: "sha256:78e3ad18a0d199dcff9e6b41878fde5fb8646035e677141b8a5e66a97b1f2f94",
                    tenant: "client",
                    client: "local-dev"
                }
            ]
        }
    });

    assert.equal(config.auth.apiKeys[0].id, "hashed-key");
});

test("rejects API key entries without key or keyHash", () => {
    assert.throws(
        () => parseConfig({
            ...baseConfig,
            auth: {
                mode: "apiKey",
                apiKeys: [
                    { id: "missing-secret", tenant: "client", client: "local-dev" }
                ]
            }
        }),
        /Either key or keyHash is required/
    );
});
