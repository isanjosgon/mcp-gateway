import assert from "node:assert/strict";
import test from "node:test";

import { copyHeadersToUpstream } from "../src/proxy.js";

test("does not forward gateway credentials to upstreams", () => {
    const headers = copyHeadersToUpstream({
        headers: {
            authorization: "Bearer dev_key_1",
            "x-api-key": "dev_key_1",
            "api-key": "dev_key_1",
            accept: "application/json",
            "mcp-session-id": "session-1"
        }
    });

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
    });

    assert.deepEqual(headers, {
        "content-type": "application/json"
    });
});
