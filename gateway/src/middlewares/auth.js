import { createHash, timingSafeEqual } from "node:crypto";

const firstHeaderValue = (value) => {
    if (Array.isArray(value)) return value.find((v) => typeof v === "string" && v.trim())?.trim() ?? null;
    return typeof value === "string" && value.trim() ? value.trim() : null;
};

const extractAuthorizationApiKey = (authorization) => {
    const value = firstHeaderValue(authorization);
    if (!value) return null;

    const separator = value.indexOf(" ");
    if (separator === -1) return null;

    const scheme = value.slice(0, separator).toLowerCase();
    if (scheme !== "bearer" && scheme !== "api-key") return null;

    const token = value.slice(separator + 1).trim();
    return token || null;
};

const extractApiKey = (headers) => {
    return extractAuthorizationApiKey(headers["authorization"])
        ?? firstHeaderValue(headers["x-api-key"])
        ?? firstHeaderValue(headers["api-key"]);
};

const authorizationDiagnostic = (authorization) => {
    const value = firstHeaderValue(authorization);
    if (!value) return { present: false };

    const separator = value.indexOf(" ");
    const scheme = separator === -1 ? value.toLowerCase() : value.slice(0, separator).toLowerCase();
    const token = separator === -1 ? "" : value.slice(separator + 1).trim();

    return {
        present: true,
        scheme,
        hasToken: Boolean(token),
        tokenLength: token.length
    };
};

export const authDiagnostic = (headers) => ({
    authorization: authorizationDiagnostic(headers["authorization"]),
    xApiKey: {
        present: Boolean(firstHeaderValue(headers["x-api-key"]))
    },
    apiKey: {
        present: Boolean(firstHeaderValue(headers["api-key"]))
    }
});

const apiKeysEqual = (a, b) => {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
};

const sha256 = (value) => {
    return createHash("sha256").update(value).digest("hex");
};

const keyHashValue = (keyHash) => {
    return keyHash.slice("sha256:".length).toLowerCase();
};

const apiKeyMatches = (apiKey, token) => {
    if (apiKey.key && apiKeysEqual(apiKey.key, token)) return true;
    if (!apiKey.keyHash) return false;

    return apiKeysEqual(keyHashValue(apiKey.keyHash), sha256(token));
};

export function authn(cfg) {
    return async (req) => {
        if (cfg.auth.mode === "none") {
            req.subject = { tenant: "anonymous", client: "anonymous" };
            return;
        }

        const token = extractApiKey(req.headers);

        if (!token) {
            const err = new Error("Missing API key");
            err.statusCode = 401;
            req.log?.warn?.({ auth: authDiagnostic(req.headers) }, "gateway auth failed: missing api key");
            throw err;
        }

        const match = cfg.auth.apiKeys.find((k) => apiKeyMatches(k, token));
        if (!match) {
            const err = new Error("Invalid API key");
            err.statusCode = 401;
            req.log?.warn?.({ auth: authDiagnostic(req.headers) }, "gateway auth failed: invalid api key");
            throw err;
        }

        req.subject = {
            tenant: match.tenant,
            client: match.client,
            ...(match.id ? { apiKeyId: match.id } : {})
        };
    };
}
