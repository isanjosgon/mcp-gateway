export function authn(cfg) {
    return async (req) => {
        if (cfg.auth.mode === "none") {
            req.subject = { tenant: "anonymous", client: "anonymous" };
            return;
        }

        const auth = req.headers["authorization"];
        const token = typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")
            ? auth.slice(7).trim()
            : null;

        if (!token) {
            const err = new Error("Missing bearer token");
            err.statusCode = 401;
            throw err;
        }

        const match = cfg.auth.apiKeys.find((k) => k.key === token);
        if (!match) {
            const err = new Error("Invalid token");
            err.statusCode = 401;
            throw err;
        }

        req.subject = { tenant: match.tenant, client: match.client, apiKey: match.key };
    };
}
