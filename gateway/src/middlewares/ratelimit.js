import { extractJsonRpcCalls } from "../utils/jsonrpc.js";

const buckets = new Map();

const rpmToRps = (rpm) => {
  return rpm / 60;
}

export function rateLimit(cfg) {
    return async (req) => {
        const subject = req.subject ?? { tenant: "anonymous", client: "anonymous" };

        let mcpMethod;
        if (req.method === "POST") {
            const calls = extractJsonRpcCalls(req.body);
            mcpMethod = calls[0]?.method;
        }

        const rpm = mcpMethod && cfg.rateLimit.byMethod[mcpMethod]
            ? cfg.rateLimit.byMethod[mcpMethod]
            : cfg.rateLimit.defaultRpm;

        const key = `${subject.tenant}:${subject.client}:${mcpMethod ?? "http:" + req.method}`;

        const now = Date.now();
        const rps = rpmToRps(rpm);
        const capacity = Math.max(1, Math.floor(rps * 10)); // burst ~10s
        const refillPerMs = rps / 1000;

        const b = buckets.get(key) ?? { tokens: capacity, lastRefill: now };
        const elapsed = now - b.lastRefill;
        b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerMs);
        b.lastRefill = now;

        if (b.tokens < 1) {
            buckets.set(key, b);
            const err = new Error("Rate limit exceeded");
            err.statusCode = 429;
            throw err;
        }

        b.tokens -= 1;
        buckets.set(key, b);
    };
}
