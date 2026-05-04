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
    const prefixes = [
        "headers",
        "req.headers",
        "request.headers",
        "res.headers",
        "reply.headers",
        "body",
        "req.body",
        "request.body",
        "body.params",
        "req.body.params",
        "request.body.params",
        "body.params.arguments",
        "req.body.params.arguments",
        "request.body.params.arguments",
        "body[*].params",
        "req.body[*].params",
        "request.body[*].params",
        "body[*].params.arguments",
        "req.body[*].params.arguments",
        "request.body[*].params.arguments",
        "err",
        "error",
        "err.headers",
        "err.config.headers",
        "err.request.headers",
        "err.response.headers"
    ];

    for (const rawKey of keys) {
        const key = rawKey.trim();
        if (!key) continue;

        paths.add(key);
        for (const prefix of prefixes) {
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

export const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"];

export function installGracefulShutdown(app, {
    processLike = process,
    signals = SHUTDOWN_SIGNALS,
    timeoutMs = 10_000,
    exit = (code) => processLike.exit(code),
    timers = { setTimeout, clearTimeout },
    logger = app.log
} = {}) {
    const handlers = new Map();
    let closing = false;
    let disposed = false;
    let timeoutId;

    const removeHandler = (signal, handler) => {
        if (typeof processLike.off === "function") {
            processLike.off(signal, handler);
            return;
        }

        processLike.removeListener?.(signal, handler);
    };

    const dispose = () => {
        if (disposed) return;

        disposed = true;
        for (const [signal, handler] of handlers.entries()) {
            removeHandler(signal, handler);
        }
        handlers.clear();

        if (timeoutId) {
            timers.clearTimeout(timeoutId);
            timeoutId = undefined;
        }
    };

    const shutdown = async (signal) => {
        if (closing) return;
        closing = true;

        logger.info({ signal }, "mcp-gateway shutting down");
        timeoutId = timers.setTimeout(() => {
            logger.error({ signal, timeoutMs }, "mcp-gateway shutdown timed out");
            exit(1);
        }, timeoutMs);
        timeoutId?.unref?.();

        try {
            await app.close();
            dispose();
            logger.info({ signal }, "mcp-gateway stopped");
            exit(0);
        } catch (err) {
            dispose();
            logger.error({ err, signal }, "mcp-gateway shutdown failed");
            exit(1);
        }
    };

    for (const signal of signals) {
        const handler = () => shutdown(signal);
        handlers.set(signal, handler);
        processLike.once(signal, handler);
    }

    app.addHook("onClose", async () => dispose());

    return dispose;
}

const isPublicRoute = (req) => req.routeOptions?.config?.public === true;

const unlessPublic = (hook) => {
    return async (req, reply) => {
        if (isPublicRoute(req)) return;
        return hook(req, reply);
    };
};

const rateLimitHealth = async (rateLimitStore) => {
    if (typeof rateLimitStore.health !== "function") {
        return { status: "unknown", type: rateLimitStore.type ?? "unknown" };
    }

    return rateLimitStore.health();
};

const healthResponse = async (rateLimitStore) => {
    const rateLimit = await rateLimitHealth(rateLimitStore);
    const ok = rateLimit.status === "ok" || rateLimit.status === "unknown";

    return {
        statusCode: ok ? 200 : 503,
        body: {
            status: ok ? "ok" : "degraded",
            service: "mcp-gateway",
            timestamp: new Date().toISOString(),
            checks: {
                rateLimit
            }
        }
    };
};

const registerHealthRoutes = (app, rateLimitStore) => {
    const handler = async (_req, reply) => {
        const result = await healthResponse(rateLimitStore);
        return reply.status(result.statusCode).send(result.body);
    };

    app.get("/healthz", { config: { public: true } }, handler);
    app.get("/health", { config: { public: true } }, handler);
};

export async function buildServer(config, { env = process.env } = {})
{
    const app = Fastify({
        logger: buildLoggerOptions(config.logging),
        bodyLimit: 2 * 1024 * 1024 // 2MB
    });
    const rateLimitStore = await createRateLimitStore({ env, logger: app.log });
    app.decorate("rateLimitStoreType", rateLimitStore.type);

    registerHealthRoutes(app, rateLimitStore);

    // Middleware chain
    app.addHook("onRequest", requestId());
    app.addHook("onRequest", unlessPublic(originGuard(config.server.allowedOrigins)));
    app.addHook("onRequest", unlessPublic(authn(config)));
    app.addHook("preHandler", unlessPublic(authzPolicy(config)));
    app.addHook("preHandler", unlessPublic(rateLimit(config, { store: rateLimitStore, env })));
    if (isAuditEnabled(config, env)) app.addHook("onResponse", audit(config, { env }));
    app.addHook("onClose", async () => rateLimitStore.close?.());

    // MCP Streamable HTTP endpoint: POST/GET/DELETE
    app.post(config.server.path, async (req, reply) => proxyUpstream(config, req, reply));
    app.get(config.server.path, async (req, reply) => proxyUpstream(config, req, reply));
    app.delete(config.server.path, async (req, reply) => proxyUpstream(config, req, reply));

    return app;
}

export async function startServer(config, { env = process.env, processLike = process } = {})
{
    const app = await buildServer(config, { env });
    const disposeShutdownHandlers = installGracefulShutdown(app, { processLike });

    try {
        await app.listen({ host: config.server.host, port: config.server.port });
    } catch (err) {
        disposeShutdownHandlers();
        throw err;
    }

    app.log.info({
        host: config.server.host,
        port: config.server.port,
        path: config.server.path,
        rateLimitStore: app.rateLimitStoreType
    }, "mcp-gateway up");

    return app;
}
