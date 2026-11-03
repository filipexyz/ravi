import { z } from "zod";
import { dbClient } from "@/server/db";
import { getOidcBaseConfig } from "@/lib/auth/oidc-config";
import { NodeManagementService } from "./nodes";
import { FileNodeCertificateIssuer } from "./node-pki";
import { FleetError } from "./contract";

const origin = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash;
});
export function nodeManagementService() {
  if (process.env.RAVI_AUTH_MODE !== "oidc") throw new FleetError("fleet_not_configured", 503);
  const config = getOidcBaseConfig();
  const transport = origin.safeParse(process.env.RAVI_FLEET_TRANSPORT_ORIGIN);
  if (!transport.success) throw new FleetError("fleet_transport_not_configured", 503);
  return new NodeManagementService(dbClient, config.organizationId, new FileNodeCertificateIssuer(),
    { console: config.origin, transport: transport.data });
}
