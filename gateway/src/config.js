import fs from "node:fs/promises";
import YAML from "yaml";
import { z } from "zod";

const EnvPlaceholder = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const HttpHeaderNameSchema = z.string()
    .min(1)
    .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, "header must be a valid HTTP header name");

const UpstreamAuthSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("apiKey"),
        apiKey: z.object({
            header: HttpHeaderNameSchema,
            value: z.string().min(1)
        })
    })
]);

const HttpUpstreamSchema = z.object({
    name: z.string(),
    type: z.literal("http"),
    url: z.string().url(),
    timeoutMs: z.number().int().positive().optional(),
    auth: UpstreamAuthSchema.optional()
});

// {arguments.<key>} (a single level) or {_meta.<a>(.<b>)*}
export const RestPathPlaceholder = /\{([^{}]*)\}/g;
const ValidRestPathRef = /^(arguments\.[A-Za-z0-9_-]+|_meta(\.[A-Za-z0-9_-]+)+)$/;

const RestToolSchema = z.object({
    name: z.string().regex(/^[a-z0-9_-]+$/, "tool name must match ^[a-z0-9_-]+$"),
    description: z.string().optional(),
    inputSchema: z.looseObject({ type: z.literal("object") }).default({ type: "object" }),
    annotations: z.record(z.string(), z.unknown()).optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
    request: z.object({
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        path: z.string()
            .startsWith("/", "request.path must start with /")
            .superRefine((path, ctx) => {
                for (const [match, ref] of path.matchAll(RestPathPlaceholder)) {
                    if (ValidRestPathRef.test(ref)) continue;
                    ctx.addIssue({
                        code: "custom",
                        message: `Invalid placeholder ${match} in request.path: use {arguments.<name>} or {_meta.<key>(.<key>)*}`
                    });
                }

                // Static part only: placeholder values are validated on call
                const staticPath = path.replace(RestPathPlaceholder, "");
                if (staticPath.includes("?") || staticPath.includes("#")) {
                    ctx.addIssue({ code: "custom", message: "request.path must not include query or hash" });
                }
                if (path.split("/").some((segment) => segment === "." || segment === "..")) {
                    ctx.addIssue({ code: "custom", message: "request.path must not include . or .. segments" });
                }
            })
    })
});

const RestUpstreamSchema = z.object({
    name: z.string(),
    type: z.literal("rest"),
    // May contain ${VAR}: it is resolved (and validated as a URL) when the config is loaded
    baseUrl: z.string(),
    timeoutMs: z.number().int().positive().optional(),
    auth: UpstreamAuthSchema.optional(),
    tools: z.array(RestToolSchema).default([])
}).superRefine((upstream, ctx) => {
    const seen = new Set();

    upstream.tools.forEach((tool, index) => {
        if (seen.has(tool.name)) {
            ctx.addIssue({
                code: "custom",
                path: ["tools", index, "name"],
                message: `Duplicate tool name: ${tool.name}`
            });
        }
        seen.add(tool.name);
    });
});

// type is optional and defaults to "http"
const UpstreamSchema = z.preprocess(
    (upstream) => (upstream && typeof upstream === "object" && upstream.type === undefined
        ? { ...upstream, type: "http" }
        : upstream),
    z.discriminatedUnion("type", [HttpUpstreamSchema, RestUpstreamSchema])
);

const RoutingRuleSchema = z.object({
    match: z.object({
        method: z.string().default("*"),
        tool: z.string().optional(),
        resource: z.string().optional(),
        prompt: z.string().optional()
    }),
    upstream: z.string()
});

const ApiKeySchema = z.object({
    id: z.string().min(1).optional(),
    key: z.string().min(1).optional(),
    keyHash: z.string().regex(/^sha256:[a-f0-9]{64}$/i, "keyHash must use sha256:<hex>").optional(),
    tenant: z.string(),
    client: z.string()
}).refine((apiKey) => apiKey.key || apiKey.keyHash, {
    message: "Either key or keyHash is required",
    path: ["key"]
});

const defaultForwardHeaders = [
    "accept",
    "content-type",
    "mcp-session-id",
    "mcp-protocol-version",
    "last-event-id"
];

const ConfigSchema = z.object({
    server: z.object({
        host: z.string().default("127.0.0.1"),
        port: z.number().int().default(8080),
        path: z.string().default("/mcp"),
        allowedOrigins: z.array(z.string()).default([]),
        requireOrigin: z.boolean().default(false)
    }),
    auth: z.object({
        mode: z.enum(["none", "apiKey"]).default("none"),
        apiKeys: z.array(ApiKeySchema).default([])
    }),
    rateLimit: z.object({
        keyPrefix: z.string().min(1).default("mcp-gateway"),
        defaultRpm: z.number().int().positive().default(600),
        byMethod: z.record(z.string(), z.number().int().positive()).default({})
    }),
    policy: z.object({
        default: z.enum(["allow", "deny"]).default("deny"),
        rules: z.array(z.object({
        subject: z.object({ tenant: z.string(), client: z.string() }),
        allow: z.object({
            methods: z.array(z.string()).default([]),
            tools: z.array(z.string()).default([]),
            resources: z.array(z.string()).default([]),
            prompts: z.array(z.string()).default([])
        }).default({ methods: [], tools: [], resources: [], prompts: [] }),
        deny: z.object({
            methods: z.array(z.string()).default([]),
            tools: z.array(z.string()).default([]),
            resources: z.array(z.string()).default([]),
            prompts: z.array(z.string()).default([])
        }).optional()
        })).default([])
    }),
    upstreams: z.array(UpstreamSchema).min(1),
    upstreamHeaders: z.object({
        forward: z.array(z.string().min(1)).default(defaultForwardHeaders)
    }).default({ forward: defaultForwardHeaders }),
    routing: z.array(RoutingRuleSchema).default([]),
    audit: z.object({
        enabled: z.boolean().default(true),
        environments: z.array(z.string().min(1)).default(["*"])
    }).default({ enabled: true, environments: ["*"] }),
    logging: z.object({
        level: z.string().default("info"),
        redactKeys: z.array(z.string()).default([])
    }).default({ level: "info", redactKeys: [] })
}).superRefine((cfg, ctx) => {
    const upstreamNames = new Set(cfg.upstreams.map((upstream) => upstream.name));

    cfg.routing.forEach((rule, index) => {
        if (!upstreamNames.has(rule.upstream)) {
            ctx.addIssue({
                code: "custom",
                path: ["routing", index, "upstream"],
                message: `Unknown upstream: ${rule.upstream}`
            });
        }
    });
});


const resolveEnvPlaceholders = (value, env, path) => {
    return value.replace(EnvPlaceholder, (_match, name) => {
        const replacement = env[name];
        if (replacement === undefined || replacement.trim() === "") {
            throw new Error(`Missing environment variable ${name} for ${path}`);
        }

        return replacement;
    });
};

const requireSecretValue = (value, path) => {
    if (!value.trim()) {
        throw new Error(`Missing secret value for ${path}`);
    }

    if (value !== value.trim()) {
        throw new Error(`Secret value must not start or end with whitespace for ${path}`);
    }

    return value;
};

const resolveUpstreamAuth = (upstream, index, env) => {
    if (upstream.auth?.type !== "apiKey") return upstream;

    const path = `upstreams[${index}].auth.apiKey.value`;

    return {
        ...upstream,
        auth: {
            ...upstream.auth,
            apiKey: {
                ...upstream.auth.apiKey,
                value: requireSecretValue(
                    resolveEnvPlaceholders(upstream.auth.apiKey.value, env, path),
                    path
                )
            }
        }
    };
};

// Unlike secrets, a missing or empty variable does not make loading fail:
// the rest upstream is left unconfigured (baseUrl null) and advertises no tools.
const resolveRestBaseUrl = (upstream, index, env) => {
    if (upstream.type !== "rest") return upstream;

    let missing = false;
    const baseUrl = upstream.baseUrl.replace(EnvPlaceholder, (_match, name) => {
        const replacement = env[name];
        if (replacement === undefined || replacement.trim() === "") missing = true;
        return replacement ?? "";
    }).trim();

    if (missing || !baseUrl) return { ...upstream, baseUrl: null };

    if (!/^https?:\/\//i.test(baseUrl) || !URL.canParse(baseUrl)) {
        throw new Error(`Invalid URL for upstreams[${index}].baseUrl`);
    }

    // Each tool path is appended to baseUrl: it cannot contain query, hash or credentials
    const url = new URL(baseUrl);
    if (baseUrl.includes("?") || baseUrl.includes("#") || url.username || url.password) {
        throw new Error(`upstreams[${index}].baseUrl must not include query, hash or credentials`);
    }

    return { ...upstream, baseUrl };
};

const resolveApiKey = (apiKey, index, env) => {
    if (!apiKey.key) return apiKey;

    const path = `auth.apiKeys[${index}].key`;

    return {
        ...apiKey,
        key: requireSecretValue(resolveEnvPlaceholders(apiKey.key, env, path), path)
    };
};

const resolveConfigSecrets = (cfg, env) => ({
    ...cfg,
    auth: {
        ...cfg.auth,
        apiKeys: cfg.auth.apiKeys.map((apiKey, index) => resolveApiKey(apiKey, index, env))
    },
    upstreams: cfg.upstreams.map((upstream, index) => {
        const resolved = resolveRestBaseUrl(upstream, index, env);
        // An unconfigured rest upstream calls nothing: its auth is not resolved
        if (resolved.type === "rest" && resolved.baseUrl === null) return resolved;

        return resolveUpstreamAuth(resolved, index, env);
    })
});

export function parseConfig(config, { env = process.env } = {})
{
    const cfg = ConfigSchema.parse(config);
    return resolveConfigSecrets(cfg, env);
}

export async function loadConfig(path, { env = process.env } = {})
{
    const raw = await fs.readFile(path, "utf8");
    const parsed = YAML.parse(raw);
    return parseConfig(parsed, { env });
}
