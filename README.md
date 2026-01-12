# mcp-gateway

A production-minded **MCP Streamable HTTP gateway** for Node.js: **auth**, **policy**, **rate limiting**, **audit logs**, and **HTTP→HTTP proxying** to one or more upstream MCP servers.

Use it to keep your upstream MCP servers **private** (only reachable from the gateway) while exposing a single controlled endpoint to clients.

---

## Why

Running MCP servers in production usually needs more than “it works”:
- **One public endpoint** instead of exposing many MCP servers
- **Centralized auth** and **least-privilege** access control
- **Rate limiting** to protect upstreams and manage cost
- **Auditable logs** for traceability and compliance
- Clean **routing** across multiple MCP upstreams

---

## Features

- MCP **Streamable HTTP** endpoint (`POST` / `GET` / `DELETE`)
- Routes requests to multiple upstream MCP servers by:
  - MCP method (e.g. `tools/call`, `tools/list`, `resources/read`, `prompts/get`)
  - tool name (`params.name`)
  - resource URI (`params.uri`)
  - prompt name (`params.name`)
- **API key auth** with `tenant` + `client` identity
- **Policy engine** (deny-by-default, allow/deny using glob patterns)
- **Rate limiting** per tenant/client (with per-method overrides)
- **Audit logs** (structured, consistent logging)
- **SSE passthrough** (`text/event-stream`) when upstream returns it
- Docker Compose-friendly setup (upstreams can remain unexposed to the host)

---

## Requirements

- **Node.js >= 20** (Node 20+ recommended)

---

## Install

### Global
```bash
npm i -g mcp-gateway
```

### Project-local
```bash
npm i mcp-gateway
```

---

## Quick start

### 1) Create a config file

Create `config.yml`:

```yaml
server:
  host: 0.0.0.0
  port: 8080
  path: /mcp
  allowedOrigins:
    - "http://localhost:3000"

auth:
  mode: apiKey
  apiKeys:
    - key: "dev_key_1"
      tenant: "client"
      client: "local-dev"

rateLimit:
  defaultRpm: 600
  byMethod:
    "tools/call": 120

policy:
  default: deny
  rules:
    - subject:
        tenant: "client"
        client: "local-dev"
      allow:
        methods:
          - "initialize"
          - "tools/list"
          - "tools/call"
          - "resources/list"
          - "resources/read"
          - "prompts/list"
          - "prompts/get"
        tools: ["*"]
        resources: ["*"]
        prompts: ["*"]

upstreams:
  - name: mcp-local
    type: http
    url: "http://mcp-dummy:9000/mcp"
    timeoutMs: 30000

routing:
  - match: { method: "*" }
    upstream: "mcp-local"

logging:
  level: "info"
  redactKeys:
    - "authorization"
    - "token"
    - "access_token"
    - "password"
    - "secret"
```

### 2) Run

Global install:
```bash
mcp-gateway run -c config.yml
```

Local install:
```bash
npx mcp-gateway run -c config.yml
```

Gateway will listen on:
- `http://localhost:8080/mcp`

---

## Try it (curl)

### initialize

```bash
curl -i "http://localhost:8080/mcp"   -H "Origin: http://localhost:3000"   -H "Authorization: Bearer dev_key_1"   -H "Accept: application/json, text/event-stream"   -H "Content-Type: application/json"   -d '{
    "jsonrpc":"2.0",
    "id":1,
    "method":"initialize",
    "params":{
      "protocolVersion":"2025-03-26",
      "capabilities":{},
      "clientInfo":{"name":"demo","version":"0.0.1"}
    }
  }'
```

If the upstream sets a session, you’ll receive a response header like:
- `Mcp-Session-Id: ...`

### tools/list

```bash
curl -s "http://localhost:8080/mcp"   -H "Origin: http://localhost:3000"   -H "Authorization: Bearer dev_key_1"   -H "Mcp-Session-Id: YOUR_SESSION_ID"   -H "Accept: application/json"   -H "Content-Type: application/json"   -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

### tools/call

```bash
curl -s "http://localhost:8080/mcp"   -H "Origin: http://localhost:3000"   -H "Authorization: Bearer dev_key_1"   -H "Mcp-Session-Id: YOUR_SESSION_ID"   -H "Accept: application/json"   -H "Content-Type: application/json"   -d '{
    "jsonrpc":"2.0",
    "id":3,
    "method":"tools/call",
    "params":{
      "name":"echo",
      "arguments":{"message":"hola"}
    }
  }'
```

---

## Routing rules

Routing is **first-match wins**. A rule can match:

- `match.method`: glob pattern for the MCP method (e.g. `tools/call`, `tools/list`, `*`)
- `match.tool`: (only for `tools/call`) glob pattern for `params.name`
- `match.resource`: (only for `resources/read`) glob pattern for `params.uri`
- `match.prompt`: (only for `prompts/get`) glob pattern for `params.name`
- `upstream`: name of the destination upstream

Example with 3 upstreams:

```yaml
upstreams:
  - name: mcp-math
    type: http
    url: "http://10.0.0.11:9000/mcp"
    timeoutMs: 30000

  - name: mcp-kb
    type: http
    url: "http://10.0.0.12:9000/mcp"
    timeoutMs: 30000

  - name: mcp-reports
    type: http
    url: "http://10.0.0.13:9000/mcp"
    timeoutMs: 45000

routing:
  - match: { method: "tools/call", tool: "math.*" }
    upstream: "mcp-math"

  - match: { method: "tools/call", tool: "kb.*" }
    upstream: "mcp-kb"

  - match: { method: "tools/call", tool: "reports.*" }
    upstream: "mcp-reports"

  - match: { method: "*" }
    upstream: "mcp-reports"
```

---

## CLI commands

```bash
mcp-gateway run -c config.yml
mcp-gateway validate -c config.yml
mcp-gateway print-config -c config.yml
mcp-gateway routes -c config.yml
mcp-gateway health
```

Inside Docker Compose:

```bash
docker compose exec mcp-gateway node src/cli.js health
docker compose exec mcp-gateway node src/cli.js routes -c /config/config.yml
docker compose exec mcp-gateway node src/cli.js validate -c /config/config.yml
```

---

## Docker Compose: keep upstream private

A common pattern is to **not publish** upstream ports to the host. Only the gateway is exposed:

- Upstream service: no `ports:` (only internal networking)
- Gateway service: `ports: ["8080:8080"]`

This keeps the MCP upstream reachable only from the gateway on the Docker network.

---

## License

MIT
