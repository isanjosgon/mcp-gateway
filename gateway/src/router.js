import { minimatch } from "minimatch";


const mm = (value, pattern) => {
  if (!pattern) return true;
  return minimatch(String(value ?? ""), pattern, { dot: true });
}

export function selectUpstream(config, req, calls) {
    const mcpMethod = req.method === "POST" ? calls?.[0]?.method : undefined;

    const toolName = mcpMethod === "tools/call" ? calls?.[0]?.params?.name : undefined;
    const resourceUri = mcpMethod === "resources/read" ? calls?.[0]?.params?.uri : undefined;
    const promptName = mcpMethod === "prompts/get" ? calls?.[0]?.params?.name : undefined;

    for (const rule of config.routing || []) {
        const m = rule.match || {};

        // method match (accepts "*" patterns)
        const methodOk = mm(mcpMethod ?? "", m.method || "*") || mm(`http:${req.method}`, m.method || "*");
        if (!methodOk) continue;

        if (m.tool && !mm(toolName, m.tool)) continue;
        if (m.resource && !mm(resourceUri, m.resource)) continue;
        if (m.prompt && !mm(promptName, m.prompt)) continue;

        const upstream = config.upstreams.find((u) => u.name === rule.upstream);
        if (upstream) return upstream;
    }

    // fallback: first upstream
    return config.upstreams[0];
}
