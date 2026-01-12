import { extractJsonRpcCalls } from "../utils/jsonrpc.js";

export function audit(_cfg) {
    return async (req, reply) => {
        const subject = req.subject ?? { tenant: "anonymous", client: "anonymous" };

        let mcpMethod;
        let toolName;

        if (req.method === "POST") {
            const calls = extractJsonRpcCalls(req.body);
            mcpMethod = calls[0]?.method;
            if (mcpMethod === "tools/call") toolName = calls[0]?.params?.name;
        }

        req.log.info({
                requestId: req.requestId,
                tenant: subject.tenant,
                client: subject.client,
                httpMethod: req.method,
                mcpMethod,
                toolName,
                statusCode: reply.statusCode
            },
            "audit"
        );
    };
}
