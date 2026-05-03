import assert from "node:assert/strict";
import test from "node:test";

import { buildLoggerOptions } from "../src/server.js";

test("builds pino redaction paths from logging redactKeys", () => {
    const loggerOptions = buildLoggerOptions({
        level: "debug",
        redactKeys: ["authorization", "x-api-key", "password"]
    });

    assert.equal(loggerOptions.level, "debug");
    assert.equal(loggerOptions.redact.censor, "[REDACTED]");
    assert.ok(loggerOptions.redact.paths.includes("authorization"));
    assert.ok(loggerOptions.redact.paths.includes("req.headers.authorization"));
    assert.ok(loggerOptions.redact.paths.includes("headers[\"x-api-key\"]"));
    assert.ok(loggerOptions.redact.paths.includes("request.headers.password"));
});

test("omits pino redact options when no redactKeys are configured", () => {
    const loggerOptions = buildLoggerOptions({ level: "info", redactKeys: [] });

    assert.deepEqual(loggerOptions, { level: "info" });
});
