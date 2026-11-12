export const applyUpstreamAuth = (headers, upstream = {}) => {
    if (upstream.auth?.type !== "apiKey") return headers;

    return {
        ...headers,
        [upstream.auth.apiKey.header.toLowerCase()]: upstream.auth.apiKey.value
    };
};
