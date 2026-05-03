import { Readable } from "node:stream";
import { extractJsonRpcCalls } from "./utils/jsonrpc.js";
import { selectUpstream } from "./router.js";

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

export const copyHeadersToUpstream = (req) => {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
        if (!v) continue;
        const key = k.toLowerCase();
        if (hopByHop.has(key)) continue;
        if (gatewayOnlyHeaders.has(key)) continue;
        headers[key] = Array.isArray(v) ? v.join(", ") : String(v);
    }
    return headers;
};

export async function proxyUpstream(config, req, reply) {
    const calls = req.method === "POST" ? extractJsonRpcCalls(req.body) : [];
    const upstream = selectUpstream(config, req, calls);

    const url = upstream.url;
    const timeoutMs = upstream.timeoutMs ?? 30000;

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const method = req.method;
        const headers = copyHeadersToUpstream(req);

        if (method === "POST" && !("content-type" in headers)) {
            headers["content-type"] = "application/json";
        }

        const body = method === "POST"
            ? (typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? null))
            : undefined;

        const res = await fetch(url, { method, headers, body, signal: controller.signal });

        reply.status(res.status);

        res.headers.forEach((value, key) => {
            const k = key.toLowerCase();
            if (hopByHop.has(k)) return;
            reply.header(key, value);
        });

        const contentType = res.headers.get("content-type") || "";

        if (contentType.includes("text/event-stream")) {
            reply.header("content-type", "text/event-stream");
            reply.header("cache-control", "no-cache");
            reply.header("connection", "keep-alive");

            Readable.fromWeb(res.body).pipe(reply.raw);
            return reply;
        }

        if (res.status === 202 || res.status === 204) return reply.send();

        const text = await res.text();
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
