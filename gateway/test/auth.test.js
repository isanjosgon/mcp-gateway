import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { authn } from "../src/middlewares/auth.js";

const config = {
    auth: {
        mode: "apiKey",
        apiKeys: [
            { id: "local-dev-key", key: "dev_key_1", tenant: "client", client: "local-dev" },
            {
                id: "hashed-key",
                keyHash: `sha256:${createHash("sha256").update("hashed_dev_key").digest("hex")}`,
                tenant: "client",
                client: "hashed-dev"
            }
        ]
    }
};

async function authenticate(headers) {
    const req = { headers };
    await authn(config)(req);
    return req.subject;
}

const localDevSubject = { tenant: "client", client: "local-dev", apiKeyId: "local-dev-key" };

test("accepts bearer authorization API keys", async () => {
    const subject = await authenticate({ authorization: "Bearer dev_key_1" });

    assert.deepEqual(subject, localDevSubject);
});

test("accepts api-key authorization API keys", async () => {
    const subject = await authenticate({ authorization: "Api-Key dev_key_1" });

    assert.deepEqual(subject, localDevSubject);
});

test("accepts x-api-key headers", async () => {
    const subject = await authenticate({ "x-api-key": "dev_key_1" });

    assert.deepEqual(subject, localDevSubject);
});

test("accepts api-key headers", async () => {
    const subject = await authenticate({ "api-key": "dev_key_1" });

    assert.deepEqual(subject, localDevSubject);
});

test("accepts hashed API keys", async () => {
    const subject = await authenticate({ authorization: "Bearer hashed_dev_key" });

    assert.deepEqual(subject, { tenant: "client", client: "hashed-dev", apiKeyId: "hashed-key" });
});

test("rejects missing API keys", async () => {
    await assert.rejects(
        () => authn(config)({ headers: {} }),
        { message: "Missing API key", statusCode: 401 }
    );
});

test("rejects invalid API keys", async () => {
    await assert.rejects(
        () => authn(config)({ headers: { authorization: "Bearer wrong_key" } }),
        { message: "Invalid API key", statusCode: 401 }
    );
});
