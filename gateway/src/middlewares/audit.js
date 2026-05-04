import { extractJsonRpcCalls } from "../utils/jsonrpc.js";

const firstNonBlank = (...values) => {
    for (const value of values) {
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
};

export function resolveAuditEnvironment(env = process.env) {
    return firstNonBlank(env.MCP_GATEWAY_ENV, env.NODE_ENV) ?? "development";
}

export function isAuditEnabled(cfg, env = process.env) {
    if (cfg.audit?.enabled === false) return false;

    const current = resolveAuditEnvironment(env);
    const environments = cfg.audit?.environments?.length ? cfg.audit.environments : ["*"];

    return environments.includes("*") || environments.includes(current);
}

export function audit(_cfg, { env = process.env } = {}) {
    return async (req, reply) => {
        const subject = req.subject ?? { tenant: "anonymous", client: "anonymous" };
        const environment = resolveAuditEnvironment(env);

        let mcpMethod;
        let toolName;

        if (req.method === "POST") {
            const calls = extractJsonRpcCalls(req.body);
            mcpMethod = calls[0]?.method;
            if (mcpMethod === "tools/call") toolName = calls[0]?.params?.name;
        }

        req.log.info({
                requestId: req.requestId,
                tenant: subject.tenant,
                client: subject.client,
                ...(subject.apiKeyId ? { apiKeyId: subject.apiKeyId } : {}),
                environment,
                httpMethod: req.method,
                mcpMethod,
                toolName,
                statusCode: reply.statusCode
            },
            "audit"
        );
    };
}
