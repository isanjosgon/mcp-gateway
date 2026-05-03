import Fastify from "fastify";

import { requestId } from "./middlewares/requestid.js";
import { originGuard } from "./middlewares/origin.js";
import { authn } from "./middlewares/auth.js";
import { authzPolicy } from "./middlewares/policy.js";
import { rateLimit } from "./middlewares/ratelimit.js";
import { audit, isAuditEnabled } from "./middlewares/audit.js";
import { proxyUpstream } from "./proxy.js";


export async function startServer(config) 
{
    const app = Fastify({
        logger: { level: config.logging.level },
        bodyLimit: 2 * 1024 * 1024 // 2MB
    });

    // Middleware chain
    app.addHook("onRequest", requestId());
    app.addHook("onRequest", originGuard(config.server.allowedOrigins));
    app.addHook("onRequest", authn(config));
    app.addHook("preHandler", authzPolicy(config));
    app.addHook("preHandler", rateLimit(config));
    if (isAuditEnabled(config)) {
        app.addHook("onResponse", audit(config));
    }

    // MCP Streamable HTTP endpoint: POST/GET/DELETE
    app.post(config.server.path, async (req, reply) => proxyUpstream(config, req, reply));
    app.get(config.server.path, async (req, reply) => proxyUpstream(config, req, reply));
    app.delete(config.server.path, async (req, reply) => proxyUpstream(config, req, reply));

    await app.listen({ host: config.server.host, port: config.server.port });
    app.log.info({ host: config.server.host, port: config.server.port, path: config.server.path }, "mcp-gateway up");
}
