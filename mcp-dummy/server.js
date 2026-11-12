import Fastify from "fastify";
import crypto from "node:crypto";

const app = Fastify({ logger: true });

// Sesiones -> { createdAt, sse: { res, timer } | null }
const sessions = new Map();

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// Sample items for the REST endpoints (gateway's upstream type: rest)
const items = new Map([
  ["1", { id: "1", name: "Item 1", price: 10 }],
  ["2", { id: "2", name: "Item 2", price: 20 }]
]);

function getSessionId(req) {
  // Node/Fastify normaliza headers a lowercase
  return req.headers["mcp-session-id"];
}

function ensureSession(req, reply) {
  let sid = getSessionId(req);
  if (!sid) {
    sid = crypto.randomUUID();
    reply.header("Mcp-Session-Id", sid);
  }
  if (!sessions.has(sid)) {
    sessions.set(sid, { createdAt: Date.now(), sse: null });
  }
  return sid;
}

function jsonrpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonrpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// Tool result compatible with the MCP SDK: JSON text + structuredContent if it is an object
function toolResult(data) {
  const isObject = data !== null && typeof data === "object" && !Array.isArray(data);
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    ...(isObject ? { structuredContent: data } : {}),
    isError: false
  };
}

function handleCall(call, req, reply) {
  const { id, method, params } = call ?? {};

  // Notificación (sin id) -> no respondemos
  if (id === undefined) return null;

  if (method === "initialize") {
    const sid = ensureSession(req, reply);
    const requested = params?.protocolVersion;
    return jsonrpcResult(id, {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0],
      serverInfo: { name: "mcp-dummy", version: "0.0.1" },
      capabilities: {
        tools: { listChanged: false }
      },
      session: { id: sid }
    });
  }

  // Requerimos sesión para lo demás
  const sid = getSessionId(req);
  if (!sid || !sessions.has(sid)) {
    return jsonrpcError(id, -32001, "Missing or invalid Mcp-Session-Id (call initialize first)");
  }

  if (method === "ping") {
    return jsonrpcResult(id, {});
  }

  if (method === "tools/list") {
    return jsonrpcResult(id, {
      tools: [
        {
          name: "echo",
          description: "Devuelve el mismo texto que le pasas.",
          inputSchema: {
            type: "object",
            properties: {
              message: { type: "string", description: "Texto a devolver" }
            },
            required: ["message"]
          }
        },
        {
          name: "add",
          description: "Suma dos números.",
          inputSchema: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "number" }
            },
            required: ["a", "b"]
          }
        }
      ]
    });
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};

    if (name === "echo") {
      return jsonrpcResult(id, toolResult({ message: String(args.message ?? "") }));
    }

    if (name === "add") {
      const a = Number(args.a);
      const b = Number(args.b);
      if (Number.isNaN(a) || Number.isNaN(b)) {
        return jsonrpcError(id, -32602, "Invalid arguments: a and b must be numbers");
      }
      return jsonrpcResult(id, toolResult({ result: a + b }));
    }

    return jsonrpcError(id, -32602, `Unknown tool: ${name}`);
  }

  return jsonrpcError(id, -32601, `Method not found: ${method}`);
}

app.post("/mcp", async (req, reply) => {
  const body = req.body;

  // JSON-RPC batch o single
  if (Array.isArray(body)) {
    const results = body
      .map((call) => handleCall(call, req, reply))
      .filter((x) => x !== null);

    // Si todo eran notificaciones, no respondemos
    if (results.length === 0) return reply.status(202).send();

    return reply.send(results);
  }

  const res = handleCall(body, req, reply);
  if (res === null) return reply.status(202).send();
  return reply.send(res);
});

// SSE: “escuchar” mensajes del servidor (aquí mandamos keepalive + un evento demo)
app.get("/mcp", async (req, reply) => {
  const sid = getSessionId(req);
  if (!sid || !sessions.has(sid)) {
    return reply.status(400).send("Missing/invalid Mcp-Session-Id (call initialize first)");
  }

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  // Guardamos el stream
  const session = sessions.get(sid);
  if (session.sse?.timer) clearInterval(session.sse.timer);

  // Keepalive cada 15s
  const timer = setInterval(() => {
    reply.raw.write(`: keepalive ${Date.now()}\n\n`);
  }, 15000);

  session.sse = { res: reply.raw, timer };

  // Evento demo (opcional)
  const demo = {
    jsonrpc: "2.0",
    method: "notifications/message",
    params: { level: "info", data: { hello: "from mcp-dummy", at: new Date().toISOString() } }
  };
  reply.raw.write(`event: message\n`);
  reply.raw.write(`data: ${JSON.stringify(demo)}\n\n`);

  req.raw.on("close", () => {
    clearInterval(timer);
    const s = sessions.get(sid);
    if (s?.sse?.res === reply.raw) s.sse = null;
  });
});

// Cierra sesión
app.delete("/mcp", async (req, reply) => {
  const sid = getSessionId(req);
  if (!sid || !sessions.has(sid)) return reply.status(204).send();

  const s = sessions.get(sid);
  if (s?.sse?.timer) clearInterval(s.sse.timer);
  try {
    s?.sse?.res?.end?.();
  } catch {}
  sessions.delete(sid);

  return reply.status(204).send();
});

// Sample REST endpoints for the gateway's upstream type: rest
app.get("/items/:id", async (req, reply) => {
  const item = items.get(req.params.id);
  if (!item) return reply.status(404).send({ error: "Item not found" });
  return reply.send(item);
});

app.post("/items", async (req, reply) => {
  const item = { ...(req.body ?? {}), id: crypto.randomUUID() };
  items.set(item.id, item);
  return reply.status(201).send(item);
});

app.setNotFoundHandler((req, reply) => {
  reply.status(404).send({ error: "Not found" });
});

await app.listen({ host: "0.0.0.0", port: 9000 });
app.log.info("mcp-dummy listening on http://0.0.0.0:9000 (MCP /mcp, REST /items)");
