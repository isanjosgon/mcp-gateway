#!/usr/bin/env bash
set -euo pipefail

# =========================
# Config (puedes sobreescribir con variables de entorno)
# =========================
BASE_URL="${BASE_URL:-http://127.0.0.1:8080/mcp}"
ORIGIN="${ORIGIN:-http://localhost:3000}"
TOKEN="${TOKEN:-dev_key_1}"

# Helpers
tmpdir="$(mktemp -d)"
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT

log() { printf "\n\033[1m%s\033[0m\n" "$*"; }
ok() { printf "✅ %s\n" "$*"; }
fail() { printf "❌ %s\n" "$*"; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Falta el comando '$1' en tu sistema."
}

need_cmd curl
# jq es opcional, pero ayuda a validar mejor
HAS_JQ=0
if command -v jq >/dev/null 2>&1; then HAS_JQ=1; fi

# timeout en mac suele no existir; a veces es gtimeout (coreutils)
TIMEOUT_CMD=""
if command -v timeout >/dev/null 2>&1; then TIMEOUT_CMD="timeout"
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_CMD="gtimeout"
fi

# =========================
# 1) initialize (capturar Mcp-Session-Id)
# =========================
log "1) initialize → capturar Mcp-Session-Id"

hdr="$tmpdir/headers.txt"
body="$tmpdir/body.txt"

curl -sS -D "$hdr" -o "$body" "$BASE_URL" \
  -H "Origin: $ORIGIN" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0",
    "id":1,
    "method":"initialize",
    "params":{
      "protocolVersion":"2025-03-26",
      "capabilities":{},
      "clientInfo":{"name":"check-script","version":"0.0.1"}
    }
  }'

SESSION_ID="$(grep -i '^Mcp-Session-Id:' "$hdr" | head -n1 | sed -E 's/^Mcp-Session-Id:[[:space:]]*//I' | tr -d '\r')"
if [[ -z "${SESSION_ID:-}" ]]; then
  echo "----- HEADERS -----"
  cat "$hdr"
  echo "----- BODY -----"
  cat "$body"
  fail "No se recibió Mcp-Session-Id. ¿Tu MCP dummy lo envía en initialize? (o ¿lo está quitando el upstream/gateway?)"
fi
ok "Sesión OK: $SESSION_ID"

if [[ $HAS_JQ -eq 1 ]]; then
  if ! jq -e '.jsonrpc=="2.0" and .id==1 and (.result or .error)' < "$body" >/dev/null; then
    echo "Body:"
    cat "$body"
    fail "Respuesta de initialize no parece JSON-RPC válido"
  fi
  ok "initialize: JSON-RPC válido"
else
  ok "initialize: (sin jq) recibido body"
fi

# =========================
# 2) tools/list
# =========================
log "2) tools/list → validar tools echo y add"

curl -sS -o "$body" "$BASE_URL" \
  -H "Origin: $ORIGIN" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

if [[ $HAS_JQ -eq 1 ]]; then
  jq -e '.id==2 and .result.tools and (.result.tools | type=="array")' < "$body" >/dev/null \
    || { echo "Body:"; cat "$body"; fail "tools/list no devolvió .result.tools[]"; }

  jq -e 'any(.result.tools[]; .name=="echo")' < "$body" >/dev/null \
    || { echo "Body:"; cat "$body"; fail "tools/list: no aparece tool 'echo'"; }

  jq -e 'any(.result.tools[]; .name=="add")' < "$body" >/dev/null \
    || { echo "Body:"; cat "$body"; fail "tools/list: no aparece tool 'add'"; }

  ok "tools/list OK: echo + add presentes"
else
  # fallback básico sin jq
  grep -q '"tools"' "$body" || fail "tools/list: no encuentro 'tools' en la respuesta"
  grep -q '"name":"echo"' "$body" || fail "tools/list: no encuentro tool echo"
  grep -q '"name":"add"' "$body" || fail "tools/list: no encuentro tool add"
  ok "tools/list OK (validación básica sin jq)"
fi

# =========================
# 3) tools/call echo
# =========================
log "3) tools/call → echo"

curl -sS -o "$body" "$BASE_URL" \
  -H "Origin: $ORIGIN" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0",
    "id":3,
    "method":"tools/call",
    "params":{"name":"echo","arguments":{"message":"hola"}}
  }'

if [[ $HAS_JQ -eq 1 ]]; then
  jq -e '.id==3 and .result and (.result.isError==false) and (.result.content | type=="array")' < "$body" >/dev/null \
    || { echo "Body:"; cat "$body"; fail "echo: respuesta inesperada"; }
  jq -e 'any(.result.content[]; .type=="text" and (.text|tostring|test("hola")))' < "$body" >/dev/null \
    || { echo "Body:"; cat "$body"; fail "echo: no devuelve 'hola'"; }
  ok "echo OK"
else
  grep -q 'hola' "$body" || { echo "Body:"; cat "$body"; fail "echo: no devuelve 'hola'"; }
  ok "echo OK (validación básica)"
fi

# =========================
# 4) tools/call add
# =========================
log "4) tools/call → add (2 + 5 = 7)"

curl -sS -o "$body" "$BASE_URL" \
  -H "Origin: $ORIGIN" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0",
    "id":4,
    "method":"tools/call",
    "params":{"name":"add","arguments":{"a":2,"b":5}}
  }'

if [[ $HAS_JQ -eq 1 ]]; then
  jq -e '.id==4 and .result and (.result.isError==false)' < "$body" >/dev/null \
    || { echo "Body:"; cat "$body"; fail "add: respuesta inesperada"; }
  jq -e 'any(.result.content[]; .type=="text" and (.text|tostring)=="7")' < "$body" >/dev/null \
    || { echo "Body:"; cat "$body"; fail "add: esperado 7"; }
  ok "add OK"
else
  grep -q '"7"' "$body" || { echo "Body:"; cat "$body"; fail "add: esperado 7"; }
  ok "add OK (validación básica)"
fi

# =========================
# 5) SSE GET (opcional)
# =========================
log "5) SSE GET (opcional)"
if [[ -n "$TIMEOUT_CMD" ]]; then
  ok "Probando SSE durante ~3s con '$TIMEOUT_CMD'…"
  set +e
  $TIMEOUT_CMD 3 curl -sS -N "$BASE_URL" \
    -H "Origin: $ORIGIN" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Mcp-Session-Id: $SESSION_ID" \
    -H "Accept: text/event-stream" \
    | head -n 5
  set -e
  ok "SSE: comando ejecutado (no validamos contenido exacto)."
else
  ok "No tienes timeout/gtimeout; salto prueba SSE."
  echo "   Si quieres probar SSE manualmente:"
  echo "   curl -N \"$BASE_URL\" -H \"Origin: $ORIGIN\" -H \"Authorization: Bearer $TOKEN\" -H \"Mcp-Session-Id: $SESSION_ID\" -H \"Accept: text/event-stream\""
fi

# =========================
# 6) DELETE (cerrar sesión)
# =========================
log "6) DELETE → cerrar sesión"

http_code="$(curl -sS -o /dev/null -w "%{http_code}" -X DELETE "$BASE_URL" \
  -H "Origin: $ORIGIN" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: $SESSION_ID")"

if [[ "$http_code" != "204" && "$http_code" != "200" ]]; then
  fail "DELETE: esperado 204/200, recibido $http_code"
fi
ok "DELETE OK ($http_code)"

log "✅ TODO OK — gateway ↔ MCP funcionando"
