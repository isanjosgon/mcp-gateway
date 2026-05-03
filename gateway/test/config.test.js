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
