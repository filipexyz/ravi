/**
 * HTTP transport for `@ravi-os/sdk`. Browser-safe — depends only on `fetch`.
 *
 * Routing matches the gateway: every call POSTs to
 * `${baseUrl}/api/v1/${groupSegments.join("/")}/${command}` with a flat JSON
 * body and `Authorization: Bearer ${contextKey}`.
 *
 * Error mapping is centralised in `errors.ts#buildErrorFromGateway` so the
 * HTTP and in-process transports never drift on which status maps to which
 * error class.
 */
import { RaviTransportError, buildErrorFromGateway, } from "../errors.js";
import { REGISTRY_HASH, SDK_VERSION } from "../version.js";
const API_PREFIX = "/api/v1";
export function createHttpTransport(config) {
    const baseUrl = stripTrailingSlash(config.baseUrl);
    const fetchImpl = config.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
        throw new Error("createHttpTransport: no global `fetch` available. Pass `config.fetch` explicitly when running in a stripped-down runtime.");
    }
    const timeoutMs = config.timeoutMs ?? 0;
    return {
        async call(input) {
            const path = `${API_PREFIX}/${[...input.groupSegments, input.command].join("/")}`;
            const url = `${baseUrl}${path}`;
            const commandLabel = `${input.groupSegments.join(".")}.${input.command}`;
            const headers = {
                "content-type": "application/json",
                accept: input.binary ? "application/octet-stream, */*" : "application/json",
                authorization: `Bearer ${config.contextKey}`,
                "x-ravi-sdk-version": SDK_VERSION,
                "x-ravi-registry-hash": REGISTRY_HASH,
                ...(config.headers ?? {}),
            };
            const controller = timeoutMs > 0 ? new AbortController() : null;
            const timeoutHandle = controller !== null ? setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs) : null;
            let response;
            try {
                response = await fetchImpl(url, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(input.body ?? {}),
                    ...(controller ? { signal: controller.signal } : {}),
                });
            }
            catch (err) {
                if (timeoutHandle)
                    clearTimeout(timeoutHandle);
                throw new RaviTransportError(err instanceof Error ? err.message : `network error calling ${commandLabel}`, err, commandLabel);
            }
            if (timeoutHandle)
                clearTimeout(timeoutHandle);
            if (input.binary) {
                if (response.ok) {
                    return response;
                }
                const rawText = await safeText(response);
                const parsed = parseJson(rawText);
                throw buildErrorFromGateway(response.status, parsed, commandLabel);
            }
            const rawText = await safeText(response);
            const parsed = parseJson(rawText);
            if (!response.ok) {
                throw buildErrorFromGateway(response.status, parsed, commandLabel);
            }
            if (parsed === null && rawText.length === 0) {
                return {};
            }
            return parsed;
        },
    };
}
function stripTrailingSlash(value) {
    return value.endsWith("/") ? value.slice(0, -1) : value;
}
async function safeText(response) {
    try {
        return await response.text();
    }
    catch {
        return "";
    }
}
function parseJson(raw) {
    if (raw.length === 0)
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return { error: "MalformedResponse", message: raw.slice(0, 1024) };
    }
}
//# sourceMappingURL=http.js.map