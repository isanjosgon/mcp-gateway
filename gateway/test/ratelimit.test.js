import assert from "node:assert/strict";
import test from "node:test";

import { rateLimit } from "../src/middlewares/ratelimit.js";
import { createMemoryRateLimitStore } from "../src/ratelimit/memory-store.js";
import { createRateLimitStore } from "../src/ratelimit/store.js";

const config = {
    rateLimit: {
        keyPrefix: "mcp-gateway",
        defaultRpm: 6,
        byMethod: {
            "tools/call": 60
        }
    }
};

const subject = { tenant: "tenant-a", client: "client-a" };

test("uses memory rate limit buckets by default", async () => {
    const limiter = rateLimit(config, {
        store: createMemoryRateLimitStore()
    });
    const req = { method: "GET", subject };

    await limiter(req);
    await assert.rejects(
        () => limiter(req),
        { message: "Rate limit exceeded", statusCode: 429 }
    );
});

test("refills memory buckets over time", async () => {
    let currentTime = 0;
    const limiter = rateLimit(config, {
        store: createMemoryRateLimitStore({ now: () => currentTime })
    });
    const req = { method: "GET", subject };

    await limiter(req);
    await assert.rejects(() => limiter(req), { statusCode: 429 });

    currentTime = 10000;

    await limiter(req);
});

test("uses MCP method overrides when building store limits", async () => {
    const calls = [];
    const limiter = rateLimit(config, {
        store: {
            async consume(key, limit) {
                calls.push({ key, limit });
                return { allowed: true };
            }
        }
    });

    await limiter({
        method: "POST",
        subject,
        body: {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "echo" }
        }
    });

    assert.equal(calls[0].key, "mcp-gateway:rate:tenant-a:client-a:tools/call");
    assert.deepEqual(calls[0].limit, {
        capacity: 10,
        refillPerMs: 0.001,
        ttlMs: 60000
    });
});

test("applies rate limits to every JSON-RPC batch call", async () => {
    const calls = [];
    const limiter = rateLimit(config, {
        store: {
            async consume(key, limit) {
                calls.push({ key, limit });
                return { allowed: true };
            }
        }
    });

    await limiter({
        method: "POST",
        subject,
        body: [
            { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } },
            { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "add" } }
        ]
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].key, "mcp-gateway:rate:tenant-a:client-a:tools/call");
    assert.equal(calls[1].key, "mcp-gateway:rate:tenant-a:client-a:tools/call");
});

test("rejects a JSON-RPC batch when any call exceeds its rate limit", async () => {
    const limiter = rateLimit({
        rateLimit: {
            keyPrefix: "mcp-gateway",
            defaultRpm: 6,
            byMethod: {
                "tools/call": 6
            }
        }
    }, {
        store: createMemoryRateLimitStore()
    });

    await assert.rejects(
        () => limiter({
            method: "POST",
            subject,
            body: [
                { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } },
                { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "add" } }
            ]
        }),
        { message: "Rate limit exceeded", statusCode: 429 }
    );
});

test("isolates rate limits by subject", async () => {
    const limiter = rateLimit(config, {
        store: createMemoryRateLimitStore()
    });

    await limiter({ method: "GET", subject: { tenant: "tenant-a", client: "client-a" } });
    await limiter({ method: "GET", subject: { tenant: "tenant-b", client: "client-a" } });
});

test("uses configured key prefix when building store keys", async () => {
    const calls = [];
    const limiter = rateLimit({
        rateLimit: {
            ...config.rateLimit,
            keyPrefix: "custom-gateway"
        }
    }, {
        store: {
            async consume(key) {
                calls.push(key);
                return { allowed: true };
            }
        },
        env: {}
    });

    await limiter({ method: "GET", subject });

    assert.equal(calls[0], "custom-gateway:rate:tenant-a:client-a:http:GET");
});

test("uses RATE_LIMIT_KEY_PREFIX before configured key prefix", async () => {
    const calls = [];
    const limiter = rateLimit(config, {
        store: {
            async consume(key) {
                calls.push(key);
                return { allowed: true };
            }
        },
        env: { RATE_LIMIT_KEY_PREFIX: "mcp-gateway:test" }
    });

    await limiter({ method: "GET", subject });

    assert.equal(calls[0], "mcp-gateway:test:rate:tenant-a:client-a:http:GET");
});

test("selects memory store when REDIS_URL is not set", async () => {
    const store = await createRateLimitStore({ env: {} });

    assert.equal(store.type, "memory");
});

test("selects memory store when REDIS_URL is blank", async () => {
    const store = await createRateLimitStore({ env: { REDIS_URL: "   " } });

    assert.equal(store.type, "memory");
});
