import Fastify from "fastify";

import { requestId } from "./middlewares/requestid.js";
import { originGuard } from "./middlewares/origin.js";
import { authn } from "./middlewares/auth.js";
import { authzPolicy } from "./middlewares/policy.js";
import { rateLimit } from "./middlewares/ratelimit.js";
import { audit, isAuditEnabled } from "./middlewares/audit.js";
import { proxyUpstream } from "./proxy.js";
import { createRateLimitStore } from "./ratelimit/store.js";

const pathForKey = (prefix, key) => {
    return /^[A-Za-z_$][\w$]*$/.test(key)
        ? `${prefix}.${key}`
        : `${prefix}["${key.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"]`;
};

const redactPaths = (keys = []) => {
    const paths = new Set();

    for (const rawKey of keys) {
        const key = rawKey.trim();
        if (!key) continue;

        paths.add(key);
        for (const prefix of ["headers", "req.headers", "request.headers", "res.headers", "reply.headers"]) {
            paths.add(pathForKey(prefix, key));
        }
    }

    return [...paths];
};

export const buildLoggerOptions = (logging = {}) => {
    const options = { level: logging.level ?? "info" };
    const paths = redactPaths(logging.redactKeys);

    if (paths.length > 0) {
        options.redact = {
            paths,
            censor: "[REDACTED]"
        };
    }

    return options;
};


export async function startServer(config) 
{
    const app = Fastify({
        logger: buildLoggerOptions(config.logging),
        bodyLimit: 2 * 1024 * 1024 // 2MB
    });
    const rateLimitStore = await createRateLimitStore({ logger: app.log });

    // Middleware chain
    app.addHook("onRequest", requestId());
    app.addHook("onRequest", originGuard(config.server.allowedOrigins));
    app.addHook("onRequest", authn(config));
    app.addHook("preHandler", authzPolicy(config));
    app.addHook("preHandler", rateLimit(config, { store: rateLimitStore }));
    if (isAuditEnabled(config)) app.addHook("onResponse", audit(config));
    app.addHook("onClose", async () => rateLimitStore.close?.());

    // MCP Streamable HTTP endpoint: POST/GET/DELETE
    app.post(config.server.path, async (req, reply) => proxyUpstream(config, req, reply));
    app.get(config.server.path, async (req, reply) => proxyUpstream(config, req, reply));
    app.delete(config.server.path, async (req, reply) => proxyUpstream(config, req, reply));

    await app.listen({ host: config.server.host, port: config.server.port });
    app.log.info({
        host: config.server.host,
        port: config.server.port,
        path: config.server.path,
        rateLimitStore: rateLimitStore.type
    }, "mcp-gateway up");
}
