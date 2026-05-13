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

const UpstreamSchema = z.object({
    name: z.string(),
    type: z.enum(["http"]).default("http"),
    url: z.string().url(),
    timeoutMs: z.number().int().positive().optional(),
    auth: UpstreamAuthSchema.optional()
});

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
        if (replacement === undefined || replacement === "") {
            throw new Error(`Missing environment variable ${name} for ${path}`);
        }

        return replacement;
    });
};

const resolveUpstreamAuth = (upstream, index, env) => {
    if (upstream.auth?.type !== "apiKey") return upstream;

    return {
        ...upstream,
        auth: {
            ...upstream.auth,
            apiKey: {
                ...upstream.auth.apiKey,
                value: resolveEnvPlaceholders(
                    upstream.auth.apiKey.value,
                    env,
                    `upstreams[${index}].auth.apiKey.value`
                )
            }
        }
    };
};

const resolveConfigSecrets = (cfg, env) => ({
    ...cfg,
    upstreams: cfg.upstreams.map((upstream, index) => resolveUpstreamAuth(upstream, index, env))
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
