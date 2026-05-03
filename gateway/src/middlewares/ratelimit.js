import { extractJsonRpcCalls } from "../utils/jsonrpc.js";
import { rpmToLimit } from "../ratelimit/limits.js";
import { createMemoryRateLimitStore } from "../ratelimit/memory-store.js";

const methodRate = (cfg, mcpMethod) => {
    return mcpMethod && cfg.rateLimit.byMethod[mcpMethod]
        ? cfg.rateLimit.byMethod[mcpMethod]
        : cfg.rateLimit.defaultRpm;
};

const rateLimitKeyPrefix = (cfg, env) => {
    return env.RATE_LIMIT_KEY_PREFIX?.trim() || cfg.rateLimit.keyPrefix || "mcp-gateway";
};

const rateLimitKey = (cfg, env, subject, req, mcpMethod) => {
    return [
        rateLimitKeyPrefix(cfg, env),
        "rate",
        subject.tenant,
        subject.client,
        mcpMethod ?? `http:${req.method}`
    ].join(":");
};

const rateLimitMethods = (req) => {
    if (req.method !== "POST") return [undefined];

    const calls = extractJsonRpcCalls(req.body);
    if (calls.length === 0) return [undefined];

    return calls.map((call) => call.method);
};

export function rateLimit(cfg, { store = createMemoryRateLimitStore(), env = process.env } = {}) {
    return async (req) => {
        const subject = req.subject ?? { tenant: "anonymous", client: "anonymous" };

        for (const mcpMethod of rateLimitMethods(req)) {
            const rpm = methodRate(cfg, mcpMethod);
            const key = rateLimitKey(cfg, env, subject, req, mcpMethod);
            const result = await store.consume(key, rpmToLimit(rpm));

            if (!result.allowed) {
                const err = new Error("Rate limit exceeded");
                err.statusCode = 429;
                throw err;
            }
        }
    };
}
