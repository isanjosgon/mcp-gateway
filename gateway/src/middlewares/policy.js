import { minimatch } from "minimatch";
import { extractJsonRpcCalls } from "../utils/jsonrpc.js";


const anyMatch = (value, patterns) => {
    return (patterns || []).some((p) => minimatch(value, p, { dot: true }));
}

export function authzPolicy(cfg) {
    return async (req) => {
        const subject = req.subject ?? { tenant: "anonymous", client: "anonymous" };

        // GET/DELETE normalmente no llevan JSON-RPC body: se controla por auth + rate
        if (req.method !== "POST") return;

        const calls = extractJsonRpcCalls(req.body);
        if (calls.length === 0) return;

        const rule = cfg.policy.rules.find((r) => r.subject.tenant === subject.tenant && r.subject.client === subject.client);

        const defaultAllow = cfg.policy.default === "allow";
        const allow = rule?.allow;
        const deny = rule?.deny;

        for (const c of calls) {
            const method = c.method ?? "";

            if (deny?.methods && anyMatch(method, deny.methods)) {
                const err = new Error(`Denied method: ${method}`);
                err.statusCode = 403;
                throw err;
            }

            if (allow?.methods?.length) {
                if (!anyMatch(method, allow.methods)) {
                    const err = new Error(`Not allowed method: ${method}`);
                    err.statusCode = 403;
                    throw err;
                }
            } else if (!defaultAllow) {
                const err = new Error(`Not allowed (no allowlist): ${method}`);
                err.statusCode = 403;
                throw err;
            }

            if (method === "tools/call") {
                const toolName = c.params?.name ?? "";
                if (deny?.tools && anyMatch(toolName, deny.tools)) {
                    const err = new Error(`Denied tool: ${toolName}`);
                    err.statusCode = 403;
                    throw err;
                }
                if (allow?.tools?.length && !anyMatch(toolName, allow.tools)) {
                    const err = new Error(`Not allowed tool: ${toolName}`);
                    err.statusCode = 403;
                    throw err;
                }
            }

            if (method === "resources/read") {
                const uri = c.params?.uri ?? "";
                if (deny?.resources && anyMatch(uri, deny.resources)) {
                    const err = new Error(`Denied resource: ${uri}`);
                    err.statusCode = 403;
                    throw err;
                }
                if (allow?.resources?.length && !anyMatch(uri, allow.resources)) {
                    const err = new Error(`Not allowed resource: ${uri}`);
                    err.statusCode = 403;
                    throw err;
                }
            }

            if (method === "prompts/get") {
                const name = c.params?.name ?? "";
                if (deny?.prompts && anyMatch(name, deny.prompts)) {
                    const err = new Error(`Denied prompt: ${name}`);
                    err.statusCode = 403;
                    throw err;
                }
                if (allow?.prompts?.length && !anyMatch(name, allow.prompts)) {
                    const err = new Error(`Not allowed prompt: ${name}`);
                    err.statusCode = 403;
                    throw err;
                }
            }
        }
    };
}
