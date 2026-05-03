export const rpmToLimit = (rpm) => {
    const rps = rpm / 60;
    const capacity = Math.max(1, Math.floor(rps * 10));
    const refillPerMs = rps / 1000;
    const ttlMs = Math.max(60000, Math.ceil((capacity / refillPerMs) * 2));

    return { capacity, refillPerMs, ttlMs };
};
