import assert from "node:assert/strict";
import test from "node:test";

import { authn } from "../src/middlewares/auth.js";

const config = {
    auth: {
        mode: "apiKey",
        apiKeys: [
            { key: "dev_key_1", tenant: "client", client: "local-dev" }
        ]
    }
};

async function authenticate(headers) {
    const req = { headers };
    await authn(config)(req);
    return req.subject;
}

test("accepts bearer authorization API keys", async () => {
    const subject = await authenticate({ authorization: "Bearer dev_key_1" });

    assert.deepEqual(subject, { tenant: "client", client: "local-dev" });
});

test("accepts api-key authorization API keys", async () => {
    const subject = await authenticate({ authorization: "Api-Key dev_key_1" });

    assert.deepEqual(subject, { tenant: "client", client: "local-dev" });
});

test("accepts x-api-key headers", async () => {
    const subject = await authenticate({ "x-api-key": "dev_key_1" });

    assert.deepEqual(subject, { tenant: "client", client: "local-dev" });
});

test("accepts api-key headers", async () => {
    const subject = await authenticate({ "api-key": "dev_key_1" });

    assert.deepEqual(subject, { tenant: "client", client: "local-dev" });
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
