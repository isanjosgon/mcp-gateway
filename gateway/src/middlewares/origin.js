export function originGuard(allowedOrigins) {
    const set = new Set(allowedOrigins || []);

    return async (req) => {
        if (set.size === 0) return;

        const origin = req.headers["origin"];
        if (!origin || typeof origin !== "string") {
            const err = new Error("Missing Origin");
            err.statusCode = 400;
            throw err;
        }
        if (!set.has(origin)) {
            const err = new Error("Origin not allowed");
            err.statusCode = 403;
            throw err;
        }
    };
}
