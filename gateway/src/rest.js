import { createRequire } from "node:module";
import { RestPathPlaceholder } from "./config.js";
import { applyUpstreamAuth } from "./utils/upstream-auth.js";

const { version } = createRequire(import.meta.url)("../package.json");

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

const hasJsonRpcId = (call) => Object.hasOwn(call, "id");

const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });

const error = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

const toolError = (text) => ({ content: [{ type: "text", text }], isError: true });

const publicTool = ({ request: _request, ...tool }) => tool;

// Tools a rest upstream advertises in tools/list (without the request block)
export const listRestTools = (upstream) => (upstream.baseUrl ? upstream.tools.map(publicTool) : []);

const valueAt = (source, path) => {
    return path.split(".").reduce(
        (value, key) => (value == null || !Object.hasOwn(Object(value), key) ? undefined : value[key]),
        source
    );
};

const isScalar = (value) => ["string", "number", "boolean"].includes(typeof value) && value !== "";

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// encodeURIComponent does not encode ".": a "." or ".." value would form a dot segment
const isDotSegment = (value) => value === "." || value === "..";

// Replaces the {dotted.path} placeholders in the path; also returns which arguments were used
const resolvePath = (path, scope) => {
    const usedArgs = new Set();
    let missing;
    let invalid;

    const resolved = path.replace(RestPathPlaceholder, (match, ref) => {
        const value = valueAt(scope, ref);
        if (!isScalar(value)) {
            missing ??= match;
            return "";
        }
        if (isDotSegment(String(value))) {
            invalid ??= match;
            return "";
        }

        const [root, arg] = ref.split(".");
        if (root === "arguments" && arg) usedArgs.add(arg);

        return encodeURIComponent(String(value));
    });

    return { resolved, usedArgs, missing, invalid };
};

// The final URL cannot leave baseUrl's origin or path prefix
const isWithinBaseUrl = (url, baseUrl) => {
    const base = new URL(baseUrl);
    const prefix = base.pathname.replace(/\/+$/, "");

    return url.origin === base.origin
        && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
};

const queryValue = (value) => (typeof value === "object" ? JSON.stringify(value) : String(value));

// With additionalProperties: false only the arguments declared in properties are sent
const isDeclaredArg = (inputSchema, key) => {
    if (inputSchema?.additionalProperties !== false) return true;
    return isPlainObject(inputSchema.properties) && Object.hasOwn(inputSchema.properties, key);
};

const buildRequest = (upstream, tool, params, headers) => {
    const args = params?.arguments ?? {};
    const { resolved, usedArgs, missing, invalid } = resolvePath(tool.request.path, {
        arguments: args,
        _meta: params?._meta ?? {}
    });

    if (missing) return { missing };
    if (invalid) return { invalid };

    const rest = Object.fromEntries(Object.entries(args)
        .filter(([key]) => !usedArgs.has(key) && isDeclaredArg(tool.inputSchema, key)));
    const method = tool.request.method;
    const url = new URL(upstream.baseUrl.replace(/\/+$/, "") + resolved);
    if (!isWithinBaseUrl(url, upstream.baseUrl)) return { invalid: tool.request.path };

    // The client's MCP headers make no sense for a REST service
    let requestHeaders = Object.fromEntries(Object.entries(headers).filter(([key]) => !key.startsWith("mcp-")));
    requestHeaders.accept = "application/json";
    let body;

    if (BODY_METHODS.has(method)) {
        body = JSON.stringify(rest);
        requestHeaders["content-type"] = "application/json";
    } else {
        delete requestHeaders["content-type"];
        for (const [key, value] of Object.entries(rest)) {
            if (value === undefined || value === null) continue;
            url.searchParams.append(key, queryValue(value));
        }
    }

    // Upstream auth goes after the filter: its header may start with mcp-
    requestHeaders = applyUpstreamAuth(requestHeaders, upstream);

    return { url, init: { method, headers: requestHeaders, body } };
};

const toToolResult = async (res) => {
    if (res.status === 204) return { content: [] };

    const text = await res.text();
    if (!text) return { content: [] };

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("json")) {
        try {
            const data = JSON.parse(text);

            return {
                content: [{ type: "text", text: JSON.stringify(data) }],
                ...(isPlainObject(data) ? { structuredContent: data } : {})
            };
        } catch {
            // non-JSON body despite the header: returned as text
        }
    }

    return { content: [{ type: "text", text }] };
};

// arguments, _meta, URL and results are not logged: they may contain personal data
const callTool = async (upstream, tool, params, headers, log) => {
    if (!upstream.baseUrl) return toolError("upstream not configured");

    const request = buildRequest(upstream, tool, params, headers);
    if (request.missing) return toolError(`Missing value for ${request.missing}`);
    if (request.invalid) return toolError(`Invalid value for ${request.invalid}`);

    const timeoutMs = upstream.timeoutMs ?? 30000;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
        // Redirects are not followed: a 3xx is treated like any other non-2xx
        const res = await fetch(request.url, { ...request.init, redirect: "manual", signal: controller.signal });

        if (!res.ok) {
            log.warn({ upstream: upstream.name, tool: tool.name, status: res.status }, "rest upstream error");
            await res.body?.cancel();
            return toolError(`HTTP ${res.status}`);
        }

        return await toToolResult(res);
    } catch (err) {
        if (controller.signal.aborted) {
            log.warn({ upstream: upstream.name, tool: tool.name, timeoutMs }, "rest upstream timeout");
            return toolError(`Timeout after ${timeoutMs} ms`);
        }

        log.error({ upstream: upstream.name, tool: tool.name, code: err.cause?.code }, "rest upstream unreachable");
        return toolError("Upstream unreachable");
    } finally {
        clearTimeout(t);
    }
};

const handleCall = async (upstream, call, headers, log) => {
    const id = call.id;

    switch (call.method) {
        case "initialize": {
            const requested = call.params?.protocolVersion;
            return result(id, {
                protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
                    ? requested
                    : SUPPORTED_PROTOCOL_VERSIONS[0],
                capabilities: { tools: {} },
                serverInfo: { name: "mcp-gateway", version }
            });
        }
        case "ping":
            return result(id, {});
        case "tools/list":
            return result(id, { tools: listRestTools(upstream) });
        case "tools/call": {
            const params = call.params;
            const tool = upstream.tools.find((t) => t.name === params?.name);
            if (!tool) return error(id, -32602, `Unknown tool: ${params?.name}`);

            if (params.arguments !== undefined && !isPlainObject(params.arguments)) {
                return error(id, -32602, "Invalid params: arguments must be an object");
            }

            return result(id, await callTool(upstream, tool, params, headers, log));
        }
        default:
            return error(id, -32601, `Method not found: ${call.method}`);
    }
};

// The gateway itself answers (JSON, no SSE or session) the MCP requests
// routed to a rest upstream. headers: headers copied from the client, without the upstream auth.
export async function handleRestUpstream(upstream, req, reply, headers) {
    if (req.method !== "POST") {
        return reply.status(405).header("allow", "POST").send();
    }

    const batch = Array.isArray(req.body);
    const calls = batch ? req.body : [req.body];

    if (calls.length === 0 || calls.some((call) => !call || typeof call !== "object")) {
        return reply.status(400).send(error(null, -32600, "Invalid Request"));
    }

    const responses = [];
    for (const call of calls) {
        if (!hasJsonRpcId(call)) continue;
        responses.push(await handleCall(upstream, call, headers, req.log));
    }

    if (responses.length === 0) return reply.status(202).send();

    return reply.send(batch ? responses : responses[0]);
}
