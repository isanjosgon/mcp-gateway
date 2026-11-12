import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { parseConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

// Local REST upstream: records each request and responds based on the path
const requests = [];

const upstreamServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
        body += chunk;
    });
    req.on("end", () => {
        requests.push({ method: req.method, url: req.url, headers: req.headers, body });

        if (req.url.startsWith("/slow")) {
            setTimeout(() => res.end("{}"), 500);
            return;
        }
        if (req.url.startsWith("/missing")) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ detail: "student 123 not found" }));
            return;
        }
        if (req.url.startsWith("/redirect")) {
            res.writeHead(302, { location: "/rest/otro" });
            res.end();
            return;
        }
        if (req.url.startsWith("/empty")) {
            res.writeHead(204);
            res.end();
            return;
        }
        if (req.url.startsWith("/array")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify([1, 2]));
            return;
        }
        if (req.url.startsWith("/text")) {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("hola");
            return;
        }
        if (req.url.startsWith("/badjson")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end("{no json");
            return;
        }

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, items: [1, 2] }));
    });
});

await new Promise((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
test.after(() => {
    upstreamServer.closeAllConnections();
    upstreamServer.close();
});

const baseUrl = `http://127.0.0.1:${upstreamServer.address().port}`;

const tools = [
    {
        name: "tutor_alumnos",
        description: "Tutor students",
        inputSchema: { type: "object", properties: { page: { type: "number" } } },
        annotations: { title: "tutor data", readOnlyHint: true },
        _meta: { context: ["from"] },
        request: { method: "GET", path: "/rest/tutores/{_meta.context.from.id}/alumnos" }
    },
    {
        name: "crear_nota",
        description: "Creates a note",
        request: { method: "POST", path: "/rest/alumnos/{arguments.id}/notas" }
    },
    {
        name: "borrar_nota",
        request: { method: "DELETE", path: "/empty/{arguments.id}" }
    },
    {
        name: "alumno_inexistente",
        request: { method: "GET", path: "/missing" }
    },
    {
        name: "lenta",
        request: { method: "GET", path: "/slow" }
    },
    {
        name: "redirige",
        request: { method: "GET", path: "/redirect" }
    },
    {
        name: "actualizar_nota",
        request: { method: "PUT", path: "/rest/notas/{arguments.id}" }
    },
    {
        name: "parchear_nota",
        request: { method: "PATCH", path: "/rest/notas/{arguments.id}" }
    },
    {
        name: "buscar",
        request: { method: "GET", path: "/rest/buscar" }
    },
    {
        name: "lista",
        request: { method: "GET", path: "/array" }
    },
    {
        name: "texto",
        request: { method: "GET", path: "/text" }
    },
    {
        name: "json_roto",
        request: { method: "GET", path: "/badjson" }
    },
    {
        name: "estricta_get",
        inputSchema: { type: "object", properties: { page: { type: "number" } }, additionalProperties: false },
        request: { method: "GET", path: "/rest/estricta/{arguments.id}" }
    },
    {
        name: "estricta_post",
        inputSchema: { type: "object", properties: { texto: { type: "string" } }, additionalProperties: false },
        request: { method: "POST", path: "/rest/estricta" }
    },
    {
        name: "sin_propiedades",
        inputSchema: { type: "object", additionalProperties: false },
        request: { method: "GET", path: "/rest/estricta" }
    },
    {
        name: "heredada",
        request: { method: "GET", path: "/rest/heredada/{_meta.constructor.name}" }
    }
];

const rawConfig = {
    server: { host: "127.0.0.1", port: 0, path: "/mcp" },
    auth: { mode: "none" },
    rateLimit: {},
    policy: { default: "allow" },
    upstreams: [
        {
            name: "web",
            type: "rest",
            baseUrl: "${REST_BASE_URL}",
            timeoutMs: 100,
            auth: {
                type: "apiKey",
                apiKey: { header: "Authorization", value: "Api-Key upstream-secret" }
            },
            tools
        }
    ],
    audit: { enabled: false },
    logging: { level: "silent" }
};

const startGateway = async (env = { REST_BASE_URL: baseUrl }) => {
    const app = await buildServer(parseConfig(rawConfig, { env }), { env: {} });
    test.after(async () => app.close());
    return app;
};

const app = await startGateway();

const rpc = (payload, headers = {}) => app.inject({
    method: "POST",
    url: "/mcp",
    headers: { "content-type": "application/json", ...headers },
    payload
});

const callTool = async (name, params = {}) => {
    const response = await rpc({ jsonrpc: "2.0", id: "c1", method: "tools/call", params: { name, ...params } });
    assert.equal(response.statusCode, 200);
    return response.json().result;
};

const lastRequest = () => requests.at(-1);

// Separate gateway with another rest upstream (on top of rawConfig) and other top-level keys
const startCustomGateway = async (upstream, config = {}) => {
    const custom = await buildServer(parseConfig({
        ...rawConfig,
        ...config,
        upstreams: [{ ...rawConfig.upstreams[0], baseUrl, ...upstream }]
    }, { env: {} }), { env: {} });
    test.after(async () => custom.close());

    return (payload, headers = {}) => custom.inject({
        method: "POST",
        url: "/mcp",
        headers: { "content-type": "application/json", ...headers },
        payload
    });
};

test("initialize answers with the requested supported protocol version", async () => {
    const response = await rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } }
    });
    const body = response.json();

    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"], /^application\/json/);
    assert.equal(response.headers["mcp-session-id"], undefined);
    assert.equal(body.id, 1);
    assert.equal(body.result.protocolVersion, "2025-03-26");
    assert.deepEqual(body.result.capabilities, { tools: {} });
    assert.equal(body.result.serverInfo.name, "mcp-gateway");
    assert.equal(typeof body.result.serverInfo.version, "string");
});

test("initialize falls back to the latest protocol version", async () => {
    const response = await rpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });

    assert.equal(response.json().result.protocolVersion, "2025-06-18");
});

test("notifications are accepted with 202 and no body", async () => {
    const response = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });

    assert.equal(response.statusCode, 202);
    assert.equal(response.body, "");
});

test("ping returns an empty result", async () => {
    const response = await rpc({ jsonrpc: "2.0", id: 3, method: "ping" });

    assert.deepEqual(response.json(), { jsonrpc: "2.0", id: 3, result: {} });
});

test("unknown methods return JSON-RPC method not found", async () => {
    const response = await rpc({ jsonrpc: "2.0", id: 4, method: "resources/list" });

    assert.equal(response.json().id, 4);
    assert.equal(response.json().error.code, -32601);
});

test("GET and DELETE on the MCP path return 405", async () => {
    for (const method of ["GET", "DELETE"]) {
        const response = await app.inject({ method, url: "/mcp" });

        assert.equal(response.statusCode, 405);
        assert.equal(response.headers.allow, "POST");
    }
});

test("tools/list returns configured tools without request details", async () => {
    const response = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/list" });
    const listed = response.json().result.tools;

    assert.equal(listed.length, tools.length);
    assert.deepEqual(listed[0], {
        name: "tutor_alumnos",
        description: "Tutor students",
        inputSchema: tools[0].inputSchema,
        annotations: tools[0].annotations,
        _meta: tools[0]._meta
    });
    assert.ok(listed.every((tool) => !("request" in tool)));
    assert.deepEqual(listed[1].inputSchema, { type: "object" });
});

test("tools/call GET resolves _meta placeholders and sends unused arguments as query", async () => {
    const result = await callTool("tutor_alumnos", {
        arguments: { page: 2, q: "a b" },
        _meta: { context: { from: { id: "tu/tor 1" } } }
    });
    const request = lastRequest();

    assert.equal(request.method, "GET");
    assert.equal(request.url, "/rest/tutores/tu%2Ftor%201/alumnos?page=2&q=a+b");
    assert.equal(request.body, "");
    assert.equal(request.headers.authorization, "Api-Key upstream-secret");
    assert.deepEqual(result, {
        content: [{ type: "text", text: JSON.stringify({ ok: true, items: [1, 2] }) }],
        structuredContent: { ok: true, items: [1, 2] }
    });
});

test("tools/call does not forward client gateway credentials", async () => {
    await rpc({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "tutor_alumnos", _meta: { context: { from: { id: 1 } } } }
    }, { "x-api-key": "client-key", "user-agent": "client" });
    const request = lastRequest();

    assert.equal(request.headers["x-api-key"], undefined);
    assert.equal(request.headers["user-agent"], "node");
    assert.equal(request.headers.authorization, "Api-Key upstream-secret");
});

test("tools/call POST sends unused arguments as JSON body", async () => {
    await callTool("crear_nota", { arguments: { id: 7, texto: "hola", nota: 9 } });
    const request = lastRequest();

    assert.equal(request.method, "POST");
    assert.equal(request.url, "/rest/alumnos/7/notas");
    assert.equal(request.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(request.body), { texto: "hola", nota: 9 });
});

test("tools/call returns empty content for 204 responses", async () => {
    const result = await callTool("borrar_nota", { arguments: { id: 1 } });

    assert.equal(lastRequest().method, "DELETE");
    assert.deepEqual(result, { content: [] });
});

test("tools/call reports missing placeholders without calling the upstream", async () => {
    const before = requests.length;
    const result = await callTool("tutor_alumnos", { arguments: {} });

    assert.equal(requests.length, before);
    assert.deepEqual(result, {
        content: [{ type: "text", text: "Missing value for {_meta.context.from.id}" }],
        isError: true
    });
});

test("tools/call rejects dot segment values without calling the upstream", async () => {
    for (const id of ["..", "."]) {
        const before = requests.length;
        const result = await callTool("crear_nota", { arguments: { id } });

        assert.equal(requests.length, before);
        assert.deepEqual(result, {
            content: [{ type: "text", text: "Invalid value for {arguments.id}" }],
            isError: true
        });
    }
});

test("tools/call rejects URLs outside the baseUrl path prefix", async () => {
    const before = requests.length;
    // Static "." and ".." are rejected on load; %2e%2e is only caught by the final URL check
    const send = await startCustomGateway({
        baseUrl: `${baseUrl}/api`,
        tools: [{ name: "fuera", request: { method: "GET", path: "/%2e%2e/rest/{arguments.id}" } }]
    });

    const response = await send({
        jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fuera", arguments: { id: 1 } }
    });

    assert.equal(requests.length, before);
    assert.deepEqual(response.json().result, {
        content: [{ type: "text", text: "Invalid value for /%2e%2e/rest/{arguments.id}" }],
        isError: true
    });
});

test("tools/call sends JSON accept and drops MCP headers", async () => {
    await rpc({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "tutor_alumnos", _meta: { context: { from: { id: 1 } } } }
    }, {
        accept: "application/json, text/event-stream",
        "mcp-session-id": "session-1",
        "mcp-protocol-version": "2025-06-18"
    });
    const request = lastRequest();

    assert.equal(request.headers.accept, "application/json");
    assert.equal(request.headers["mcp-session-id"], undefined);
    assert.equal(request.headers["mcp-protocol-version"], undefined);
    assert.equal(request.headers.authorization, "Api-Key upstream-secret");
});

test("tools/call sends the upstream auth header even if it starts with mcp-", async () => {
    const send = await startCustomGateway({
        auth: { type: "apiKey", apiKey: { header: "Mcp-Token", value: "upstream-secret" } },
        tools: [tools[0]]
    }, {
        upstreamHeaders: { forward: ["mcp-token", "mcp-session-id"] }
    });

    await send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "tutor_alumnos", _meta: { context: { from: { id: 1 } } } }
    }, { "mcp-token": "client-token", "mcp-session-id": "session-1" });
    const request = lastRequest();

    assert.equal(request.headers["mcp-token"], "upstream-secret");
    assert.equal(request.headers["mcp-session-id"], undefined);
    assert.equal(request.headers.authorization, undefined);
});

test("tools/call forwards custom headers listed in upstreamHeaders.forward", async () => {
    const send = await startCustomGateway({ tools: [tools[0]] }, {
        upstreamHeaders: { forward: ["x-tenant"] }
    });

    await send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "tutor_alumnos", _meta: { context: { from: { id: 1 } } } }
    }, { "x-tenant": "smartick", "x-other": "no" });
    const request = lastRequest();

    assert.equal(request.headers["x-tenant"], "smartick");
    assert.equal(request.headers["x-other"], undefined);
    assert.equal(request.headers.authorization, "Api-Key upstream-secret");
});

test("tools/call keeps the baseUrl path prefix", async () => {
    const send = await startCustomGateway({ baseUrl: `${baseUrl}/api/`, tools: [tools[0]] });

    const response = await send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "tutor_alumnos", arguments: { page: 1 }, _meta: { context: { from: { id: 5 } } } }
    });

    assert.equal(lastRequest().url, "/api/rest/tutores/5/alumnos?page=1");
    assert.equal(response.json().result.structuredContent.ok, true);
});

test("tools/call PUT and PATCH send unused arguments as JSON body", async () => {
    for (const [name, method] of [["actualizar_nota", "PUT"], ["parchear_nota", "PATCH"]]) {
        await callTool(name, { arguments: { id: 3, nota: 8 } });
        const request = lastRequest();

        assert.equal(request.method, method);
        assert.equal(request.url, "/rest/notas/3");
        assert.equal(request.headers["content-type"], "application/json");
        assert.deepEqual(JSON.parse(request.body), { nota: 8 });
    }
});

test("tools/call serializes object query values as JSON and omits null ones", async () => {
    await callTool("buscar", { arguments: { filtro: { curso: 3 }, lista: [1, 2], nada: null, n: 0 } });
    const url = new URL(lastRequest().url, "http://x");

    assert.equal(url.pathname, "/rest/buscar");
    assert.deepEqual([...url.searchParams], [["filtro", "{\"curso\":3}"], ["lista", "[1,2]"], ["n", "0"]]);
});

test("tools/call drops undeclared arguments when additionalProperties is false", async () => {
    await callTool("estricta_get", { arguments: { id: 4, page: 2, extra: "x" } });
    assert.equal(lastRequest().url, "/rest/estricta/4?page=2");

    await callTool("estricta_post", { arguments: { texto: "hola", extra: "x" } });
    assert.deepEqual(JSON.parse(lastRequest().body), { texto: "hola" });

    await callTool("sin_propiedades", { arguments: { extra: "x" } });
    assert.equal(lastRequest().url, "/rest/estricta");

    await callTool("buscar", { arguments: { extra: "x" } });
    assert.equal(lastRequest().url, "/rest/buscar?extra=x");
});

test("tools/call does not resolve inherited properties in placeholders", async () => {
    const before = requests.length;
    const result = await callTool("heredada", { _meta: {} });

    assert.equal(requests.length, before);
    assert.deepEqual(result, {
        content: [{ type: "text", text: "Missing value for {_meta.constructor.name}" }],
        isError: true
    });
});

test("tools/call returns JSON arrays without structuredContent", async () => {
    assert.deepEqual(await callTool("lista"), { content: [{ type: "text", text: "[1,2]" }] });
});

test("tools/call returns non-JSON responses as text", async () => {
    assert.deepEqual(await callTool("texto"), { content: [{ type: "text", text: "hola" }] });
    assert.deepEqual(await callTool("json_roto"), { content: [{ type: "text", text: "{no json" }] });
});

test("tools/call does not follow redirects", async () => {
    const before = requests.length;
    const result = await callTool("redirige");

    assert.equal(requests.length, before + 1);
    assert.deepEqual(result, { content: [{ type: "text", text: "HTTP 302" }], isError: true });
});

test("tools/call with non-object arguments returns invalid params", async () => {
    for (const args of ["x", [1], null]) {
        const before = requests.length;
        const response = await rpc({
            jsonrpc: "2.0",
            id: 10,
            method: "tools/call",
            params: { name: "crear_nota", arguments: args }
        });

        assert.equal(requests.length, before);
        assert.equal(response.json().id, 10);
        assert.equal(response.json().error.code, -32602);
    }
});

test("tools/call reports non-2xx responses without the body", async () => {
    const result = await callTool("alumno_inexistente");

    assert.deepEqual(result, { content: [{ type: "text", text: "HTTP 404" }], isError: true });
});

test("tools/call reports timeouts", async () => {
    const result = await callTool("lenta");

    assert.deepEqual(result, { content: [{ type: "text", text: "Timeout after 100 ms" }], isError: true });
});

test("tools/call with an unknown tool returns invalid params", async () => {
    const response = await rpc({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "nope" } });

    assert.equal(response.json().id, 8);
    assert.equal(response.json().error.code, -32602);
});

test("batch requests answer every call with an id", async () => {
    const response = await rpc([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" }
    ]);
    const body = response.json();

    assert.equal(response.statusCode, 200);
    assert.deepEqual(body.map((r) => r.id), [1, 2]);
});

test("unconfigured rest upstreams start without tools", async () => {
    const unconfigured = await startGateway({});
    const send = (payload) => unconfigured.inject({
        method: "POST",
        url: "/mcp",
        headers: { "content-type": "application/json" },
        payload
    });

    const list = await send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.deepEqual(list.json().result, { tools: [] });

    const call = await send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tutor_alumnos" } });
    assert.deepEqual(call.json().result, {
        content: [{ type: "text", text: "upstream not configured" }],
        isError: true
    });

    const unknown = await send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope" } });
    assert.equal(unknown.json().error.code, -32602);
});

test("tools/call reports unreachable upstreams", async () => {
    const closedServer = http.createServer();
    await new Promise((resolve) => closedServer.listen(0, "127.0.0.1", resolve));
    const { port } = closedServer.address();
    await new Promise((resolve) => closedServer.close(resolve));

    const unreachable = await startGateway({ REST_BASE_URL: `http://127.0.0.1:${port}` });
    const response = await unreachable.inject({
        method: "POST",
        url: "/mcp",
        headers: { "content-type": "application/json" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "alumno_inexistente" } }
    });

    assert.deepEqual(response.json().result, {
        content: [{ type: "text", text: "Upstream unreachable" }],
        isError: true
    });
});
