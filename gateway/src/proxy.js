import { Readable } from "node:stream";
import { extractJsonRpcCalls } from "./utils/jsonrpc.js";
import { selectUpstream } from "./router.js";
import { handleRestUpstream, listRestTools } from "./rest.js";
import { applyUpstreamAuth } from "./utils/upstream-auth.js";

const hopByHop = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "content-encoding"
]);

const gatewayOnlyHeaders = new Set([
    "authorization",
    "x-api-key",
    "api-key"
]);

const forwardedHeaders = (config) => {
    return new Set((config.upstreamHeaders?.forward ?? []).map((header) => header.toLowerCase()));
};

export const copyHeadersToUpstream = (req, config = {}) => {
    const allowed = forwardedHeaders(config);
    const headers = {};

    for (const [k, v] of Object.entries(req.headers)) {
        if (!v) continue;
        const key = k.toLowerCase();
        if (hopByHop.has(key)) continue;
        if (gatewayOnlyHeaders.has(key)) continue;
        if (!allowed.has(key)) continue;
        headers[key] = Array.isArray(v) ? v.join(", ") : String(v);
    }

    return headers;
};

export { applyUpstreamAuth };

export const looksLikeEventStream = (text) => {
    if (typeof text !== "string") return false;

    return /^(event|data|id|retry):(?:[^\r\n]*)(?:\r?\n|$)/.test(text.trimStart());
};

const sendEventStreamText = (reply, text) => {
    reply.header("content-type", "text/event-stream; charset=utf-8");
    reply.header("cache-control", "no-cache");
    return reply.send(text);
};

// Request forwarded to an http upstream: same allowed headers, its auth and the same body
const upstreamInit = (req, upstream, headers) => {
    const method = req.method;

    if (method === "POST" && !("content-type" in headers)) {
        headers["content-type"] = "application/json";
    }

    const body = method === "POST"
        ? (typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? null))
        : undefined;

    return { method, headers: applyUpstreamAuth(headers, upstream), body };
};

// Only with several upstreams and a single tools/list with id (no batch)
const isMergedToolsList = (config, req) => {
    const body = req.body;

    return config.upstreams.length > 1
        && req.method === "POST"
        && body !== null && typeof body === "object" && !Array.isArray(body)
        && body.method === "tools/list"
        && Object.hasOwn(body, "id");
};

// JSON-RPC message with the given id inside an SSE response
const findEventStreamMessage = (text, id) => {
    for (const event of text.split(/\r?\n\r?\n/)) {
        const data = event.split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
        if (!data) continue;

        try {
            const message = JSON.parse(data);
            if (message?.id === id) return message;
        } catch {
            // non-JSON event: ignored
        }
    }

    return undefined;
};

// tools of an http upstream; throws an Error whose message is the reason (without response data)
const fetchHttpTools = async (config, req, upstream, routed) => {
    const headers = copyHeadersToUpstream(req, config);
    // The client session only belongs to the upstream chosen by routing
    if (!routed) delete headers["mcp-session-id"];

    const timeoutMs = upstream.timeoutMs ?? 30000;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(upstream.url, { ...upstreamInit(req, upstream, headers), signal: controller.signal });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const contentType = res.headers.get("content-type") || "";
        let message;
        if (contentType.includes("text/event-stream") || (!contentType && looksLikeEventStream(text))) {
            message = findEventStreamMessage(text, req.body.id);
        } else {
            try {
                message = JSON.parse(text);
            } catch {
                // treated as an invalid response
            }
        }

        if (message?.error) throw new Error("JSON-RPC error");
        if (!Array.isArray(message?.result?.tools)) throw new Error("invalid response");

        return message.result.tools;
    } catch (err) {
        if (controller.signal.aborted) throw new Error(`timeout after ${timeoutMs} ms`);
        throw err;
    } finally {
        clearTimeout(t);
    }
};

// tools/list with several upstreams: merges the tools of all of them in config.upstreams order.
// A failing upstream is skipped; with repeated names the first one wins. No pagination.
const mergeToolsList = async (config, req, reply, routedUpstream) => {
    const results = await Promise.allSettled(config.upstreams.map(async (upstream) => (
        upstream.type === "rest"
            ? listRestTools(upstream)
            : fetchHttpTools(config, req, upstream, upstream === routedUpstream)
    )));

    const tools = [];
    const owners = new Map();

    results.forEach((settled, index) => {
        const upstream = config.upstreams[index].name;

        if (settled.status === "rejected") {
            const reason = settled.reason?.cause?.code ?? settled.reason?.message ?? "unknown";
            req.log.warn({ upstream, reason }, "tools/list upstream skipped");
            return;
        }

        for (const tool of settled.value) {
            const name = tool?.name;
            if (owners.has(name)) {
                req.log.warn({ tool: name, upstream, kept: owners.get(name) }, "tools/list duplicate tool skipped");
                continue;
            }
            owners.set(name, upstream);
            tools.push(tool);
        }
    });

    return reply.send({ jsonrpc: "2.0", id: req.body.id, result: { tools } });
};

export async function proxyUpstream(config, req, reply) {
    const calls = req.method === "POST" ? extractJsonRpcCalls(req.body) : [];
    const upstream = selectUpstream(config, req, calls);

    if (isMergedToolsList(config, req)) {
        return mergeToolsList(config, req, reply, upstream);
    }

    if (upstream.type === "rest") {
        return handleRestUpstream(upstream, req, reply, copyHeadersToUpstream(req, config));
    }

    const url = upstream.url;
    const timeoutMs = upstream.timeoutMs ?? 30000;

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const init = upstreamInit(req, upstream, copyHeadersToUpstream(req, config));

        const res = await fetch(url, { ...init, signal: controller.signal });

        reply.status(res.status);

        res.headers.forEach((value, key) => {
            const k = key.toLowerCase();
            if (hopByHop.has(k)) return;
            reply.header(key, value);
        });

        const contentType = res.headers.get("content-type") || "";

        if (contentType.includes("text/event-stream")) {
            reply.header("content-type", "text/event-stream; charset=utf-8");
            reply.header("cache-control", "no-cache");

            return reply.send(Readable.fromWeb(res.body));
        }

        if (res.status === 202 || res.status === 204) return reply.send();

        const text = await res.text();
        if (!contentType && looksLikeEventStream(text)) {
            return sendEventStreamText(reply, text);
        }

        try {
            return reply.send(JSON.parse(text));
        } catch {
            return reply.send(text);
        }
    } catch (err) {
        req.log.error({ err, upstream: upstream?.name }, "upstream proxy failed");
        return reply.status(502).send({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Gateway: upstream unreachable" }
        });
    } finally {
        clearTimeout(t);
    }
}
