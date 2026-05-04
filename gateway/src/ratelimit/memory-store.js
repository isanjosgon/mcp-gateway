export function createMemoryRateLimitStore({ now = () => Date.now() } = {}) {
    const buckets = new Map();

    return {
        type: "memory",

        async consume(key, limit) {
            const currentTime = now();
            const bucket = buckets.get(key) ?? { tokens: limit.capacity, lastRefill: currentTime };
            const elapsed = Math.max(0, currentTime - bucket.lastRefill);

            bucket.tokens = Math.min(
                limit.capacity,
                bucket.tokens + elapsed * limit.refillPerMs
            );
            bucket.lastRefill = currentTime;

            if (bucket.tokens < 1) {
                buckets.set(key, bucket);
                return { allowed: false };
            }

            bucket.tokens -= 1;
            buckets.set(key, bucket);

            return { allowed: true };
        },

        async close() {
            buckets.clear();
        },

        async health() {
            return { status: "ok", type: "memory" };
        }
    };
}
