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

test("resolves upstream API key auth env placeholders", () => {
    const config = parseConfig({
        ...baseConfig,
        upstreams: [
            {
                name: "agents-staging",
                type: "http",
                url: "https://apidev.smartickia.com/api/v2/mcp",
                auth: {
                    type: "apiKey",
                    apiKey: {
                        header: "Authorization",
                        value: "Api-Key ${AGENTS_STAGING_MCP_API_KEY}"
                    }
                }
            }
        ],
        routing: [
            { match: { method: "*" }, upstream: "agents-staging" }
        ]
    }, {
        env: { AGENTS_STAGING_MCP_API_KEY: "upstream-secret" }
    });

    assert.equal(
        config.upstreams[0].auth.apiKey.value,
        "Api-Key upstream-secret"
    );
});

test("rejects upstream API key auth when an env placeholder is missing", () => {
    assert.throws(
        () => parseConfig({
            ...baseConfig,
            upstreams: [
                {
                    name: "agents-staging",
                    type: "http",
                    url: "https://apidev.smartickia.com/api/v2/mcp",
                    auth: {
                        type: "apiKey",
                        apiKey: {
                            header: "Authorization",
                            value: "Api-Key ${AGENTS_STAGING_MCP_API_KEY}"
                        }
                    }
                }
            ],
            routing: [
                { match: { method: "*" }, upstream: "agents-staging" }
            ]
        }, {
            env: {}
        }),
        /Missing environment variable AGENTS_STAGING_MCP_API_KEY/
    );
});

test("rejects invalid upstream API key header names", () => {
    assert.throws(
        () => parseConfig({
            ...baseConfig,
            upstreams: [
                {
                    name: "agents-staging",
                    type: "http",
                    url: "https://apidev.smartickia.com/api/v2/mcp",
                    auth: {
                        type: "apiKey",
                        apiKey: {
                            header: "Bad Header",
                            value: "Api-Key upstream-secret"
                        }
                    }
                }
            ],
            routing: [
                { match: { method: "*" }, upstream: "agents-staging" }
            ]
        }),
        /valid HTTP header name/
    );
});
