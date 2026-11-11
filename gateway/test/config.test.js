import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../src/config.js";

const baseConfig = {
    server: {
        host: "127.0.0.1",
        port: 8080,
        path: "/mcp",
        allowedOrigins: []
    },
    auth: {
        mode: "none",
        apiKeys: []
    },
    rateLimit: {
        keyPrefix: "mcp-gateway",
        defaultRpm: 600,
        byMethod: {}
    },
    policy: {
        default: "allow",
        rules: []
    },
    upstreams: [
        { name: "mcp-local", type: "http", url: "http://127.0.0.1:9000/mcp" }
    ],
    routing: [
        { match: { method: "*" }, upstream: "mcp-local" }
    ]
};

test("accepts routing rules that reference configured upstreams", () => {
    const config = parseConfig(baseConfig);

    assert.equal(config.routing[0].upstream, "mcp-local");
    assert.equal(config.server.requireOrigin, false);
});

test("accepts strict Origin requirement config", () => {
    const config = parseConfig({
        ...baseConfig,
        server: {
            ...baseConfig.server,
            requireOrigin: true
        }
    });

    assert.equal(config.server.requireOrigin, true);
});

test("rejects routing rules that reference unknown upstreams", () => {
    assert.throws(
        () => parseConfig({
            ...baseConfig,
            routing: [
                { match: { method: "*" }, upstream: "missing-upstream" }
            ]
        }),
        /Unknown upstream: missing-upstream/
    );
});

test("accepts hashed API key entries", () => {
    const config = parseConfig({
        ...baseConfig,
        auth: {
            mode: "apiKey",
            apiKeys: [
                {
                    id: "hashed-key",
                    keyHash: "sha256:78e3ad18a0d199dcff9e6b41878fde5fb8646035e677141b8a5e66a97b1f2f94",
                    tenant: "client",
                    client: "local-dev"
                }
            ]
        }
    });

    assert.equal(config.auth.apiKeys[0].id, "hashed-key");
});

test("resolves gateway API key env placeholders", () => {
    const config = parseConfig({
        ...baseConfig,
        auth: {
            mode: "apiKey",
            apiKeys: [
                {
                    id: "env-key",
                    key: "${MCP_GATEWAY_API_KEY}",
                    tenant: "client",
                    client: "local-dev"
                }
            ]
        }
    }, {
        env: { MCP_GATEWAY_API_KEY: "gateway-secret" }
    });

    assert.equal(config.auth.apiKeys[0].key, "gateway-secret");
});

test("rejects gateway API key env placeholders when the env var is missing", () => {
    assert.throws(
        () => parseConfig({
            ...baseConfig,
            auth: {
                mode: "apiKey",
                apiKeys: [
                    {
                        id: "env-key",
                        key: "${MCP_GATEWAY_API_KEY}",
                        tenant: "client",
                        client: "local-dev"
                    }
                ]
            }
        }, {
            env: {}
        }),
        /Missing environment variable MCP_GATEWAY_API_KEY for auth\.apiKeys\[0\]\.key/
    );
});

test("rejects gateway API key env placeholders when the env var is blank", () => {
    assert.throws(
        () => parseConfig({
            ...baseConfig,
            auth: {
                mode: "apiKey",
                apiKeys: [
                    {
                        id: "env-key",
                        key: "${MCP_GATEWAY_API_KEY}",
                        tenant: "client",
                        client: "local-dev"
                    }
                ]
            }
        }, {
            env: { MCP_GATEWAY_API_KEY: "   " }
        }),
        /Missing environment variable MCP_GATEWAY_API_KEY for auth\.apiKeys\[0\]\.key/
    );
});

test("rejects API key entries without key or keyHash", () => {
    assert.throws(
        () => parseConfig({
            ...baseConfig,
            auth: {
                mode: "apiKey",
                apiKeys: [
                    { id: "missing-secret", tenant: "client", client: "local-dev" }
                ]
            }
        }),
        /Either key or keyHash is required/
    );
});

test("resolves upstream API key auth env placeholders", () => {
    const config = parseConfig({
        ...baseConfig,
        upstreams: [
            {
                name: "example-upstream",
                type: "http",
                url: "https://mcp-upstream.example.com/api/v2/mcp",
                auth: {
                    type: "apiKey",
                    apiKey: {
                        header: "Authorization",
                        value: "Api-Key ${EXAMPLE_UPSTREAM_API_KEY}"
                    }
                }
            }
        ],
        routing: [
            { match: { method: "*" }, upstream: "example-upstream" }
        ]
    }, {
        env: { EXAMPLE_UPSTREAM_API_KEY: "upstream-secret" }
    });

    assert.equal(
        config.upstreams[0].auth.apiKey.value,
        "Api-Key upstream-secret"
    );
});

test("rejects upstream API key auth when an env placeholder is missing", () => {
    assert.throws(
        () => parseConfig({
            ...baseConfig,
            upstreams: [
                {
                    name: "example-upstream",
                    type: "http",
                    url: "https://mcp-upstream.example.com/api/v2/mcp",
                    auth: {
                        type: "apiKey",
                        apiKey: {
                            header: "Authorization",
                            value: "Api-Key ${EXAMPLE_UPSTREAM_API_KEY}"
                        }
                    }
                }
            ],
            routing: [
                { match: { method: "*" }, upstream: "example-upstream" }
            ]
        }, {
            env: {}
        }),
        /Missing environment variable EXAMPLE_UPSTREAM_API_KEY/
    );
});

test("rejects upstream API key auth when an env placeholder is blank", () => {
    assert.throws(
        () => parseConfig({
            ...baseConfig,
            upstreams: [
                {
                    name: "example-upstream",
                    type: "http",
                    url: "https://mcp-upstream.example.com/api/v2/mcp",
                    auth: {
                        type: "apiKey",
                        apiKey: {
                            header: "Authorization",
                            value: "Api-Key ${EXAMPLE_UPSTREAM_API_KEY}"
                        }
                    }
                }
            ],
            routing: [
                { match: { method: "*" }, upstream: "example-upstream" }
            ]
        }, {
            env: { EXAMPLE_UPSTREAM_API_KEY: "   " }
        }),
        /Missing environment variable EXAMPLE_UPSTREAM_API_KEY/
    );
});

test("rejects upstream API key auth values with trailing whitespace", () => {
    assert.throws(
        () => parseConfig({
            ...baseConfig,
            upstreams: [
                {
                    name: "example-upstream",
                    type: "http",
                    url: "https://mcp-upstream.example.com/api/v2/mcp",
                    auth: {
                        type: "apiKey",
                        apiKey: {
                            header: "Authorization",
                            value: "Custom-Prefix "
                        }
                    }
                }
            ],
            routing: [
                { match: { method: "*" }, upstream: "example-upstream" }
            ]
        }),
        /Secret value must not start or end with whitespace for upstreams\[0\]\.auth\.apiKey\.value/
    );
});

test("rejects invalid upstream API key header names", () => {
    assert.throws(
        () => parseConfig({
            ...baseConfig,
            upstreams: [
                {
                    name: "example-upstream",
                    type: "http",
                    url: "https://mcp-upstream.example.com/api/v2/mcp",
                    auth: {
                        type: "apiKey",
                        apiKey: {
                            header: "Bad Header",
                            value: "Api-Key upstream-secret"
                        }
                    }
                }
            ],
            routing: [
                { match: { method: "*" }, upstream: "example-upstream" }
            ]
        }),
        /valid HTTP header name/
    );
});

const restUpstream = {
    name: "web",
    type: "rest",
    baseUrl: "${REST_BASE_URL}",
    tools: [
        {
            name: "tutor_alumnos",
            description: "Tutor students",
            request: { method: "GET", path: "/rest/tutores/{_meta.context.from.id}/alumnos" }
        }
    ]
};

test("accepts rest upstreams and defaults upstream type to http", () => {
    const config = parseConfig({
        ...baseConfig,
        upstreams: [
            { name: "mcp-local", url: "http://127.0.0.1:9000/mcp" },
            restUpstream
        ]
    }, {
        env: { REST_BASE_URL: "https://api.example.com" }
    });

    assert.equal(config.upstreams[0].type, "http");
    assert.equal(config.upstreams[1].type, "rest");
    assert.equal(config.upstreams[1].baseUrl, "https://api.example.com");
    assert.deepEqual(config.upstreams[1].tools[0].inputSchema, { type: "object" });
});

test("rejects duplicate tool names in a rest upstream", () => {
    assert.throws(
        () => parseConfig({
            ...baseConfig,
            upstreams: [
                { ...restUpstream, tools: [restUpstream.tools[0], restUpstream.tools[0]] }
            ],
            routing: []
        }, {
            env: { REST_BASE_URL: "https://api.example.com" }
        }),
        /Duplicate tool name: tutor_alumnos/
    );
});

test("rejects invalid rest tool names", () => {
    assert.throws(
        () => parseConfig({
            ...baseConfig,
            upstreams: [
                { ...restUpstream, tools: [{ ...restUpstream.tools[0], name: "Tutor.Alumnos" }] }
            ],
            routing: []
        }, {
            env: { REST_BASE_URL: "https://api.example.com" }
        }),
        /tool name must match/
    );
});

test("leaves rest upstream unconfigured when the baseUrl env var is missing or blank", () => {
    for (const env of [{}, { REST_BASE_URL: "  " }]) {
        const config = parseConfig({
            ...baseConfig,
            upstreams: [restUpstream],
            routing: []
        }, { env });

        assert.equal(config.upstreams[0].baseUrl, null);
    }
});

test("rejects rest upstreams with an invalid baseUrl", () => {
    assert.throws(
        () => parseConfig({
            ...baseConfig,
            upstreams: [restUpstream],
            routing: []
        }, {
            env: { REST_BASE_URL: "not-a-url" }
        }),
        /Invalid URL for upstreams\[0\]\.baseUrl/
    );
});

test("rejects rest request paths with invalid placeholders", () => {
    for (const placeholder of ["{arguments.a.b}", "{arguments}", "{id}", "{_meta}", "{_meta.a b}", "{}"]) {
        assert.throws(
            () => parseConfig({
                ...baseConfig,
                upstreams: [{
                    ...restUpstream,
                    tools: [{ name: "t", request: { method: "GET", path: `/items/${placeholder}` } }]
                }],
                routing: []
            }, {
                env: { REST_BASE_URL: "https://api.example.com" }
            }),
            /Invalid placeholder .* in request\.path/
        );
    }
});

test("accepts arguments and nested _meta placeholders in rest request paths", () => {
    const config = parseConfig({
        ...baseConfig,
        upstreams: [{
            ...restUpstream,
            tools: [{ name: "t", request: { method: "GET", path: "/a/{arguments.item-id}/{_meta.context.from_1.id}" } }]
        }],
        routing: []
    }, {
        env: { REST_BASE_URL: "https://api.example.com" }
    });

    assert.equal(config.upstreams[0].tools[0].request.path, "/a/{arguments.item-id}/{_meta.context.from_1.id}");
});

test("rejects rest baseUrl with query, hash or credentials", () => {
    for (const url of [
        "https://api.example.com/api?x=1",
        "https://api.example.com/api?",
        "https://api.example.com/api#frag",
        "https://user:pass@api.example.com",
        "https://user@api.example.com"
    ]) {
        assert.throws(
            () => parseConfig({
                ...baseConfig,
                upstreams: [restUpstream],
                routing: []
            }, {
                env: { REST_BASE_URL: url }
            }),
            /upstreams\[0\]\.baseUrl must not include query, hash or credentials/
        );
    }
});

test("rejects rest request paths with static dot segments, query or hash", () => {
    for (const path of ["/a/../b", "/a/./b", "/..", "/a/{arguments.id}/..", "/a?x=1", "/a/{arguments.id}?x", "/a#frag"]) {
        assert.throws(
            () => parseConfig({
                ...baseConfig,
                upstreams: [{ ...restUpstream, tools: [{ name: "t", request: { method: "GET", path } }] }],
                routing: []
            }, {
                env: { REST_BASE_URL: "https://api.example.com" }
            }),
            /request\.path must not include/,
            path
        );
    }
});

test("does not resolve auth of an unconfigured rest upstream", () => {
    const config = parseConfig({
        ...baseConfig,
        upstreams: [{
            ...restUpstream,
            auth: { type: "apiKey", apiKey: { header: "Authorization", value: "Api-Key ${REST_API_KEY}" } }
        }],
        routing: []
    }, { env: {} });

    assert.equal(config.upstreams[0].baseUrl, null);
});

test("still requires auth env vars of a configured rest upstream", () => {
    assert.throws(
        () => parseConfig({
            ...baseConfig,
            upstreams: [{
                ...restUpstream,
                auth: { type: "apiKey", apiKey: { header: "Authorization", value: "Api-Key ${REST_API_KEY}" } }
            }],
            routing: []
        }, {
            env: { REST_BASE_URL: "https://api.example.com" }
        }),
        /Missing environment variable REST_API_KEY for upstreams\[0\]\.auth\.apiKey\.value/
    );
});
