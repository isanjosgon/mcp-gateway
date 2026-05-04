import assert from "node:assert/strict";
import test from "node:test";

import { applyUpstreamAuth, copyHeadersToUpstream } from "../src/proxy.js";

const config = {
    upstreamHeaders: {
        forward: ["accept", "content-type", "mcp-session-id"]
    }
};

test("does not forward gateway credentials to upstreams", () => {
    const headers = copyHeadersToUpstream({
        headers: {
            authorization: "Bearer dev_key_1",
            "x-api-key": "dev_key_1",
            "api-key": "dev_key_1",
            accept: "application/json",
            "mcp-session-id": "session-1"
        }
    }, config);

    assert.deepEqual(headers, {
        accept: "application/json",
        "mcp-session-id": "session-1"
    });
});

test("does not forward hop-by-hop headers to upstreams", () => {
    const headers = copyHeadersToUpstream({
        headers: {
            connection: "keep-alive",
            "content-length": "100",
            "content-type": "application/json"
        }
    }, config);

    assert.deepEqual(headers, {
        "content-type": "application/json"
    });
});

test("only forwards headers included in upstream allowlist", () => {
    const headers = copyHeadersToUpstream({
        headers: {
            accept: "application/json",
            "mcp-session-id": "session-1",
            "user-agent": "client",
            origin: "https://app.example.com"
        }
    }, config);

    assert.deepEqual(headers, {
        accept: "application/json",
        "mcp-session-id": "session-1"
    });
});

test("never forwards gateway credentials even when configured", () => {
    const headers = copyHeadersToUpstream({
        headers: {
            authorization: "Bearer dev_key_1",
            "x-api-key": "dev_key_1",
            accept: "application/json"
        }
    }, {
        upstreamHeaders: {
            forward: ["authorization", "x-api-key", "accept"]
        }
    });

    assert.deepEqual(headers, {
        accept: "application/json"
    });
});

test("adds configured upstream API key auth", () => {
    const headers = applyUpstreamAuth({
        accept: "application/json"
    }, {
        auth: {
            type: "apiKey",
            apiKey: {
                header: "Authorization",
                value: "Api-Key upstream-secret"
            }
        }
    });

    assert.deepEqual(headers, {
        accept: "application/json",
        authorization: "Api-Key upstream-secret"
    });
});

test("uses upstream auth instead of client gateway credentials", () => {
    const headers = applyUpstreamAuth(copyHeadersToUpstream({
        headers: {
            authorization: "Bearer dev_key_1",
            accept: "application/json",
            "mcp-session-id": "session-1"
        }
    }, {
        upstreamHeaders: {
            forward: ["authorization", "accept", "mcp-session-id"]
        }
    }), {
        auth: {
            type: "apiKey",
            apiKey: {
                header: "Authorization",
                value: "Api-Key upstream-secret"
            }
        }
    });

    assert.deepEqual(headers, {
        accept: "application/json",
        "mcp-session-id": "session-1",
        authorization: "Api-Key upstream-secret"
    });
});
