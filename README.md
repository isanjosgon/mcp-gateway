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
- **API key auth** with `tenant` + `client` identity via `Bearer`, `Api-Key`, or API key headers
- **Policy engine** (deny-by-default, allow/deny using glob patterns)
- **Rate limiting** per tenant/client (with per-method overrides, in-memory or Redis-backed)
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
npm i -g @isanjosgon/mcp-gateway
```

### Project-local
```bash
npm i @isanjosgon/mcp-gateway
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
  # Set REDIS_URL=redis://... to share limits across gateway instances.
  # Without REDIS_URL, the gateway uses in-memory rate limit buckets.
  # Override keyPrefix with RATE_LIMIT_KEY_PREFIX to separate environments.
  keyPrefix: "mcp-gateway"
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

audit:
  enabled: true
  # Environment is resolved from MCP_GATEWAY_ENV, then NODE_ENV, then "development".
  # Use ["*"] to log audit events in all environments.
  environments: ["production", "staging"]

logging:
  level: "info"
  redactKeys:
    - "authorization"
    - "x-api-key"
    - "api-key"
    - "token"
    - "access_token"
    - "password"
    - "secret"
```

API keys can be sent using any of these request headers:

```http
Authorization: Bearer dev_key_1
Authorization: Api-Key dev_key_1
X-API-Key: dev_key_1
Api-Key: dev_key_1
```

### 2) Run

Global install:
```bash
mcp-gateway run -c config.yml
```

Local install:
```bash
npx @isanjosgon/mcp-gateway run -c config.yml
```

Gateway will listen on:
- `http://localhost:8080/mcp`

Audit logs are enabled by default. The active environment is resolved from
`MCP_GATEWAY_ENV`, then `NODE_ENV`, then `development`. Use
`audit.environments` to choose where audit events are emitted, for example
`["production", "staging"]`, or `["*"]` for all environments.

Rate limiting uses in-memory buckets by default. Set `REDIS_URL`, for example
`REDIS_URL=redis://localhost:6379`, to use Redis-backed buckets shared across
gateway instances. If `REDIS_URL` is set and Redis cannot be reached, startup
fails instead of silently falling back to memory.

Redis keys use this shape:

```txt
<keyPrefix>:rate:<tenant>:<client>:<method>
```

Use a distinct `rateLimit.keyPrefix` per product, deployment, or environment,
for example `mcp-gateway:prod`. `RATE_LIMIT_KEY_PREFIX` overrides the config
value at runtime.

Runtime environment variables:

| Variable | Purpose |
| --- | --- |
| `REDIS_URL` | Enables Redis-backed rate limiting, for example `redis://localhost:6379`. |
| `RATE_LIMIT_KEY_PREFIX` | Overrides `rateLimit.keyPrefix` to separate products or environments sharing Redis. |
| `MCP_GATEWAY_ENV` | Primary environment name used by audit filtering. |
| `NODE_ENV` | Fallback environment name when `MCP_GATEWAY_ENV` is not set. |

Gateway credentials are used only at the gateway boundary. `Authorization`,
`X-API-Key`, and `Api-Key` request headers are not forwarded to upstream MCP
servers.

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

- Redis service: no `ports:` (only internal networking)
- Upstream service: no `ports:` (only internal networking)
- Gateway service: `ports: ["8080:8080"]`

This keeps Redis and the MCP upstream reachable only from the gateway on the
Docker network. The included `docker-compose.yml` sets
`REDIS_URL=redis://redis:6379` so rate limits are shared across gateway
instances that use the same Redis and key prefix.

---

## License

MIT
