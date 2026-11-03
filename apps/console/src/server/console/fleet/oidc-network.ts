import { lookup } from "node:dns/promises";
import { request } from "node:https";
import ipaddr from "ipaddr.js";
import type { CustomFetch } from "openid-client";
import { FleetError } from "./contract";
import { pinnedOidcLookup } from "./oidc-lookup";

export function oidcAddressAllowed(address: string, allowPrivate: boolean) {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.parse(address);
  // Initial contract is IPv4 only; no IPv4-mapped IPv6, local or metadata targets.
  if (parsed.kind() !== "ipv4" || address === "100.100.100.200") return false;
  const range = parsed.range();
  return range === "unicast" || (allowPrivate && ["private", "carrierGradeNat"].includes(range));
}

/** All OIDC endpoints must share the explicitly trusted issuer origin. TLS uses
 * the original hostname while lookup returns only the already checked address.
 * This intentionally does not support IdPs with cross-origin endpoints yet. */
export function constrainedOidcFetch(issuer: string, allowPrivate: boolean): CustomFetch {
  const origin = new URL(issuer).origin;
  return async (input, options) => {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password || url.hash) {
      throw new FleetError("oidc_endpoint_not_allowed");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let addresses;
    try {
      addresses = await Promise.race([lookup(url.hostname, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new FleetError("oidc_dns_timeout")), 3000); timer.unref(); })]);
    } catch { throw new FleetError("oidc_target_unreachable"); }
    finally { clearTimeout(timer); }
    if (!addresses.length || addresses.some(item => !oidcAddressAllowed(item.address, allowPrivate))) throw new FleetError("oidc_target_not_allowed");
    const address = addresses[0]!.address;
    const body = options.body == null ? null : typeof options.body === "string" ? options.body
      : options.body instanceof URLSearchParams ? options.body.toString() : null;
    if (options.body != null && body === null) throw new FleetError("oidc_body_not_supported");
    if (body && Buffer.byteLength(body) > 65536) throw new FleetError("oidc_request_too_large");
    return new Promise<Response>((resolve, reject) => {
      const req = request(url, { method: options.method, headers: options.headers, agent: false,
        lookup: pinnedOidcLookup(address),
        signal: options.signal, rejectUnauthorized: true,
      }, response => {
        const chunks: Buffer[] = []; let bytes = 0;
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
          response.destroy(); req.destroy(); reject(new FleetError("oidc_redirect_refused")); return;
        }
        response.on("data", (part: Buffer) => {
          bytes += part.byteLength;
          if (bytes > 524288) { response.destroy(); req.destroy(); reject(new FleetError("oidc_response_too_large")); }
          else chunks.push(part);
        });
        response.on("error", () => reject(new FleetError("oidc_transport_failed")));
        response.on("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
          resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 502, headers }));
        });
      });
      const deadline = setTimeout(() => req.destroy(new Error("timeout")), 10000);
      req.on("close", () => clearTimeout(deadline));
      req.on("error", () => reject(new FleetError("oidc_transport_failed")));
      req.end(body);
    });
  };
}
