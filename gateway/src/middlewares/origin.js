const missingOriginError = () => {
    const err = new Error("Missing Origin");
    err.statusCode = 400;
    return err;
};

export function originGuard(allowedOrigins, { requireOrigin = false } = {}) {
    const set = new Set(allowedOrigins || []);

    return async (req) => {
        if (set.size === 0) return;

        const origin = req.headers["origin"];
        if (!origin || typeof origin !== "string") {
            if (requireOrigin) throw missingOriginError();
            return;
        }
        if (!set.has(origin)) {
            const err = new Error("Origin not allowed");
            err.statusCode = 403;
            throw err;
        }
    };
}
