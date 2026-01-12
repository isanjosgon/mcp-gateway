import crypto from "node:crypto";


export function requestId() 
{
    return async (req) => {
        req.requestId = crypto.randomUUID();
    };
}
