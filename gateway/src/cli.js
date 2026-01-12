#!/usr/bin/env node

import { Command } from "commander";
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

const program = new Command();

program
    .name("mcp-gateway")
    .description("MCP Gateway (Streamable HTTP)")
    .version("0.1.0")
    .option("-c, --config <path>", "Path to config.yml");

program
    .command("run")
    .description("Start the gateway server")
    .action(async () => {
        const opts = program.opts();
        if (!opts.config) throw new Error("Missing --config");
        const cfg = await loadConfig(opts.config);
        await startServer(cfg);
    });

program
    .command("validate")
    .description("Validate config and exit")
    .action(async () => {
        const opts = program.opts();
        if (!opts.config) throw new Error("Missing --config");
        await loadConfig(opts.config);
        console.log("OK: config válido");
    });

program
    .command("routes")
    .description("Print upstreams and routing table")
    .action(async () => {
        const opts = program.opts();
        if (!opts.config) throw new Error("Missing --config");
        const cfg = await loadConfig(opts.config);

        console.log("Upstreams:");
        for (const u of cfg.upstreams) {
            console.log(`- ${u.name} (${u.type}) ${u.url} timeoutMs=${u.timeoutMs ?? "-"}`);
        }

        console.log("\nRouting (first match wins):");
        if (!cfg.routing?.length) {
            console.log("- (vacío) -> fallback cfg.upstreams[0]");
            return;
        }
        for (const r of cfg.routing) {
            const m = r.match || {};
            const parts = [];
            if (m.method) parts.push(`method=${m.method}`);
            if (m.tool) parts.push(`tool=${m.tool}`);
            if (m.resource) parts.push(`resource=${m.resource}`);
            if (m.prompt) parts.push(`prompt=${m.prompt}`);
            console.log(`- [${parts.join(", ")}] -> ${r.upstream}`);
        }
    });

program
    .command("health")
    .description("Health check")
    .action(() => console.log("ok"));

program.action(async () => {
    // comando por defecto = run
    const opts = program.opts();
    if (!opts.config) {
        program.help({ error: true });
    }
    const cfg = await loadConfig(opts.config);
    await startServer(cfg);
});

await program.parseAsync(process.argv);
