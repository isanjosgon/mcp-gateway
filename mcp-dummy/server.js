import Fastify from "fastify";
import crypto from "node:crypto";

const app = Fastify({ logger: true });

// Sesiones -> { createdAt, sse: { res, timer } | null }
const sessions = new Map();

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

function handleCall(call, req, reply) {
  const { id, method, params } = call ?? {};

  // Notificación (sin id) -> no respondemos
  if (id === undefined) return null;

  if (method === "initialize") {
    const sid = ensureSession(req, reply);
    return jsonrpcResult(id, {
      protocolVersion: "2025-03-26",
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
      ],
      nextCursor: null
    });
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};

    if (name === "echo") {
      return jsonrpcResult(id, {
        content: [{ type: "text", text: String(args.message ?? "") }],
        isError: false
      });
    }

    if (name === "add") {
      const a = Number(args.a);
      const b = Number(args.b);
      if (Number.isNaN(a) || Number.isNaN(b)) {
        return jsonrpcError(id, -32602, "Invalid arguments: a and b must be numbers");
      }
      return jsonrpcResult(id, {
        content: [{ type: "text", text: String(a + b) }],
        isError: false
      });
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
    if (results.length === 0) return reply.status(204).send();

    return reply.send(results);
  }

  const res = handleCall(body, req, reply);
  if (res === null) return reply.status(204).send();
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
  reply.raw.write(`event: message\n`);
  reply.raw.write(`data: ${JSON.stringify({ hello: "from mcp-dummy", at: new Date().toISOString() })}\n\n`);

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

await app.listen({ host: "0.0.0.0", port: 9000 });
app.log.info("mcp-dummy listening on http://0.0.0.0:9000/mcp");
