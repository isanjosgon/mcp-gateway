import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { parseConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

// Local MCP upstreams: each path responds differently and requests are recorded
const requests = [];

const tool = (name) => ({ name, description: `tool ${name}`, inputSchema: { type: "object" } });

const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
};

const upstreamServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
        raw += chunk;
    });
    req.on("end", () => {
        const body = JSON.parse(raw || "null");
        requests.push({ path: req.url, headers: req.headers, body });

        if (req.url === "/a") {
            if (body.method === "tools/call") {
                send(res, 200, { jsonrpc: "2.0", id: body.id, result: { content: [], from: "a" } });
                return;
            }
            send(res, 200, {
                jsonrpc: "2.0",
                id: body.id,
                result: { tools: [tool("a_uno"), tool("comun")], nextCursor: "next" }
            }, { "mcp-session-id": "session-a" });
            return;
        }
        if (req.url === "/b") {
            // SSE with an earlier message of another id before the response
            const result = body.method === "tools/call"
                ? { content: [], from: "b" }
                : { tools: [tool("b_uno"), tool("comun")] };
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end([
                `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: "otro", result: { tools: [tool("x")] } })}\n\n`,
                `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`
            ].join(""));
            return;
        }
        if (req.url === "/error") {
            send(res, 200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no" } });
            return;
        }
        if (req.url === "/invalid") {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("hola");
            return;
        }
        if (req.url === "/http500") {
            send(res, 500, { error: "boom" });
            return;
        }
        if (req.url === "/slow") {
            setTimeout(() => send(res, 200, { jsonrpc: "2.0", id: body.id, result: { tools: [tool("lenta")] } }), 500);
            return;
        }

        send(res, 404, {});
    });
});

await new Promise((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
test.after(() => {
    upstreamServer.closeAllConnections();
    upstreamServer.close();
});

const origin = `http://127.0.0.1:${upstreamServer.address().port}`;

// Port with no server for the down upstream
const closed = http.createServer();
await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
const downUrl = `http://127.0.0.1:${closed.address().port}/mcp`;
await new Promise((resolve) => closed.close(resolve));

const httpUpstream = (name, path, extra = {}) => ({ name, type: "http", url: `${origin}${path}`, ...extra });

const restUpstream = {
    name: "web",
    type: "rest",
    baseUrl: origin,
    tools: [
        {
            name: "r_uno",
            description: "rest tool",
            request: { method: "GET", path: "/rest/one" }
        }
    ]
};

const startGateway = async (upstreams, routing = []) => {
    const app = await buildServer(parseConfig({
        server: { host: "127.0.0.1", port: 0, path: "/mcp" },
        auth: { mode: "none" },
        rateLimit: {},
        policy: { default: "allow" },
        upstreams,
        routing,
        audit: { enabled: false },
        logging: { level: "silent" }
    }, { env: {} }), { env: {} });
    test.after(async () => app.close());

    return (payload, headers = {}) => app.inject({
        method: "POST",
        url: "/mcp",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        payload
    });
};

const listTools = { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} };

const names = (response) => response.json().result.tools.map((t) => t.name);

const requestsTo = (path) => requests.filter((r) => r.path === path);

test("tools/list merges http (JSON and SSE) and rest upstreams in config order", async () => {
    const rpc = await startGateway([httpUpstream("a", "/a"), httpUpstream("b", "/b"), restUpstream]);

    const response = await rpc(listTools);
    const body = response.json();

    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"], /^application\/json/);
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.id, 7);
    assert.deepEqual(names(response), ["a_uno", "comun", "b_uno", "r_uno"]);
    assert.equal(body.result.nextCursor, undefined);
    assert.deepEqual(body.result.tools[3], {
        name: "r_uno",
        description: "rest tool",
        inputSchema: { type: "object" }
    });
    assert.equal(response.headers["mcp-session-id"], undefined);
});

test("tools/list keeps the first tool when names are repeated", async () => {
    const rpc = await startGateway([httpUpstream("b", "/b"), httpUpstream("a", "/a")]);

    const response = await rpc(listTools);

    assert.deepEqual(names(response), ["b_uno", "comun", "a_uno"]);
});

test("tools/list skips failing upstreams and returns the rest", async () => {
    const rpc = await startGateway([
        { name: "down", type: "http", url: downUrl },
        httpUpstream("slow", "/slow", { timeoutMs: 100 }),
        httpUpstream("error", "/error"),
        httpUpstream("invalid", "/invalid"),
        httpUpstream("http500", "/http500"),
        httpUpstream("a", "/a"),
        restUpstream
    ]);

    const response = await rpc(listTools);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(names(response), ["a_uno", "comun", "r_uno"]);
});

test("tools/list with a single upstream is proxied as before", async () => {
    const rpc = await startGateway([httpUpstream("a", "/a")]);

    const response = await rpc(listTools);

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["mcp-session-id"], "session-a");
    assert.equal(response.json().result.nextCursor, "next");
    assert.deepEqual(names(response), ["a_uno", "comun"]);
});

test("tools/call still follows routing with several upstreams", async () => {
    const rpc = await startGateway(
        [httpUpstream("a", "/a"), httpUpstream("b", "/b"), restUpstream],
        [
            { match: { method: "tools/call", tool: "b_*" }, upstream: "b" },
            { match: { method: "*" }, upstream: "a" }
        ]
    );
    const before = requests.length;

    const response = await rpc({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "b_uno" } });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"], /^text\/event-stream/);
    assert.match(response.body, /"from":"b"/);
    assert.deepEqual(requests.slice(before).map((r) => r.path), ["/b"]);
});

test("tools/list batches and other methods are not merged", async () => {
    const rpc = await startGateway([httpUpstream("a", "/a"), httpUpstream("b", "/b")]);
    const before = requests.length;

    const response = await rpc([listTools]);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(requests.slice(before).map((r) => r.path), ["/a"]);
});

test("client mcp-session-id only reaches the upstream routed for tools/list", async () => {
    const rpc = await startGateway(
        [httpUpstream("b", "/b"), httpUpstream("a", "/a")],
        [{ match: { method: "*" }, upstream: "a" }]
    );
    const beforeA = requestsTo("/a").length;
    const beforeB = requestsTo("/b").length;

    await rpc(listTools, { "mcp-session-id": "client-session" });

    const toA = requestsTo("/a").slice(beforeA);
    const toB = requestsTo("/b").slice(beforeB);
    assert.equal(toA.length, 1);
    assert.equal(toB.length, 1);
    assert.equal(toA[0].headers["mcp-session-id"], "client-session");
    assert.equal(toB[0].headers["mcp-session-id"], undefined);
    assert.equal(toB[0].headers.accept, "application/json, text/event-stream");
    assert.deepEqual(toB[0].body, listTools);
});
