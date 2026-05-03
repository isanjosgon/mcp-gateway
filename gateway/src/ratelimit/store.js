import { createMemoryRateLimitStore } from "./memory-store.js";
import { createRedisRateLimitStore } from "./redis-store.js";

export async function createRateLimitStore({ env = process.env, logger } = {}) {
    const redisUrl = env.REDIS_URL?.trim();

    if (!redisUrl) {
        return createMemoryRateLimitStore();
    }

    return createRedisRateLimitStore({ url: redisUrl, logger });
}
