import fs from "node:fs/promises";
import YAML from "yaml";
import { z } from "zod";


const UpstreamSchema = z.object({
    name: z.string(),
    type: z.enum(["http"]).default("http"),
    url: z.string().url(),
    timeoutMs: z.number().int().positive().optional()
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
        allowedOrigins: z.array(z.string()).default([])
    }),
    auth: z.object({
        mode: z.enum(["none", "apiKey"]).default("none"),
        apiKeys: z.array(z.object({
            key: z.string(),
            tenant: z.string(),
            client: z.string()
        })).default([])
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


export function parseConfig(config)
{
    return ConfigSchema.parse(config);
}

export async function loadConfig(path)
{
    const raw = await fs.readFile(path, "utf8");
    const parsed = YAML.parse(raw);
    return parseConfig(parsed);
}
