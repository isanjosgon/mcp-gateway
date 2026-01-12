export function extractJsonRpcCalls(body) {
    if (!body) return [];
    if (Array.isArray(body)) return body.filter((x) => x && typeof x === "object");
    if (typeof body === "object") return [body];
    return [];
}
