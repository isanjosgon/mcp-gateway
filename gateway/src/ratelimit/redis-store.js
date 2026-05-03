const consumeScript = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refill_per_ms = tonumber(ARGV[3])
local ttl_ms = tonumber(ARGV[4])

local bucket = redis.call("HMGET", key, "tokens", "lastRefill")
local tokens = tonumber(bucket[1]) or capacity
local last_refill = tonumber(bucket[2]) or now
local elapsed = math.max(0, now - last_refill)

tokens = math.min(capacity, tokens + (elapsed * refill_per_ms))

if tokens < 1 then
    redis.call("HSET", key, "tokens", tokens, "lastRefill", now)
    redis.call("PEXPIRE", key, ttl_ms)
    return 0
end

tokens = tokens - 1
redis.call("HSET", key, "tokens", tokens, "lastRefill", now)
redis.call("PEXPIRE", key, ttl_ms)
return 1
`;

export async function createRedisRateLimitStore({ url, logger }) {
    const { createClient } = await import("redis");
    const client = createClient({ url });

    client.on("error", (err) => {
        logger?.error({ err }, "redis rate limit store error");
    });

    await client.connect();

    return {
        type: "redis",

        async consume(key, limit) {
            const allowed = await client.sendCommand([
                "EVAL",
                consumeScript,
                "1",
                key,
                String(Date.now()),
                String(limit.capacity),
                String(limit.refillPerMs),
                String(limit.ttlMs)
            ]);

            return { allowed: Number(allowed) === 1 };
        },

        async close() {
            if (!client.isOpen) return;

            if (typeof client.close === "function") {
                await client.close();
            } else if (typeof client.quit === "function") {
                await client.quit();
            } else if (typeof client.destroy === "function") {
                client.destroy();
            }
        }
    };
}
